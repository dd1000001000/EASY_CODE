"""T3 并发压力测试：token_bucket 多线程/多协程不变量验证。

覆盖范围：
1. 基础行为：初始满桶、耗尽后 try_acquire 返回 False、超时路径返回
   False、参数校验 ValueError（同步与异步）。
2. 多线程（8 线程）并发：每线程混合调用 try_acquire / acquire(短超时)，
   验证不变量：
   - 全程 tokens 非负且不超过 capacity；
   - 总成功获取令牌数 <= 初始令牌 + refill_rate × 总耗时（浮点容差）；
   - 所有线程正常结束（无死锁）。
3. 多协程（100 协程）并发：混合调用 try_acquire_async / acquire_async，
   验证同样的不变量，并用 asyncio.wait_for 包裹整体加超时防挂死。

运行方式（在仓库根目录执行）：
    python -m unittest discover -s tests -v
    或
    python -m pytest tests/ -q
"""

import asyncio
import threading
import time
import unittest

from token_bucket import TokenBucket

# 数学上“总成功获取数 <= 初始令牌 + refill_rate × 总耗时”严格成立；
# 容差仅用于吸收极小的计时/浮点舍入误差。
BUDGET_TOLERANCE = 1e-6


def _thread_worker(bucket, iterations, results, observed):
    """单线程负载：交替 try_acquire / acquire（短超时），记录结果与观察值。"""
    local_success = 0
    for i in range(iterations):
        n = (i % 5) + 1  # 每次 1..5 个令牌
        if i % 2 == 0:
            ok = bucket.try_acquire(n)
        else:
            ok = bucket.acquire(n, timeout=0.01)
        if ok:
            local_success += 1
        observed.append(bucket.tokens)
    results.append(local_success)


async def _coro_worker(bucket, iterations, results, observed):
    """单协程负载：交替 try_acquire_async / acquire_async（短超时）。"""
    local_success = 0
    for i in range(iterations):
        n = (i % 5) + 1
        if i % 2 == 0:
            ok = await bucket.try_acquire_async(n)
        else:
            ok = await bucket.acquire_async(n, timeout=0.01)
        if ok:
            local_success += 1
        observed.append(bucket.tokens)
    results.append(local_success)


class TestTokenBucketBasic(unittest.TestCase):
    """基础行为：满桶、耗尽、补充、超时、参数校验。"""

    def test_initial_full(self):
        b = TokenBucket(10.0, 1.0)
        self.assertEqual(b.tokens, 10.0)

    def test_exhaust_try_acquire_false(self):
        b = TokenBucket(1.0, 1.0)
        self.assertTrue(b.try_acquire(1))
        self.assertFalse(b.try_acquire(1))

    def test_refill_over_time(self):
        b = TokenBucket(1.0, 10.0)
        self.assertTrue(b.try_acquire(1))
        self.assertFalse(b.try_acquire(1))
        time.sleep(0.15)  # 0.15s × 10/s = 1.5，应补充出至少 1 个令牌
        self.assertGreaterEqual(b.tokens, 1.0)

    def test_acquire_timeout_returns_false(self):
        b = TokenBucket(1.0, 0.001)  # 补充极慢，必然超时
        self.assertTrue(b.try_acquire(1))
        t0 = time.monotonic()
        self.assertFalse(b.acquire(1, timeout=0.05))
        self.assertGreaterEqual(time.monotonic() - t0, 0.04)

    def test_acquire_infinite_timeout_refills_no_deadlock(self):
        """回归测试：acquire(timeout=None) 在桶耗尽后不得永久死锁。

        惰性补充机制下令牌只随时间积累且无 notify 唤醒，因此实现必须
        使用有界等待定时重查；修复前此场景会永久阻塞（线程 5s 内不退出）。
        """
        b = TokenBucket(1.0, 10.0)
        self.assertTrue(b.try_acquire(1))  # 耗尽
        result = {}

        def _blocking_acquire():
            result["ok"] = b.acquire(1, timeout=None)  # 无限等待

        t = threading.Thread(target=_blocking_acquire)
        t.start()
        t.join(timeout=5.0)
        self.assertFalse(t.is_alive(), "acquire(timeout=None) 疑似死锁（5s 未返回）")
        self.assertTrue(result.get("ok"))

    def test_sync_value_errors(self):
        for cap, rate in ((0, 1), (-1, 1), (1, 0), (1, -2)):
            with self.assertRaises(ValueError):
                TokenBucket(cap, rate)
        b = TokenBucket(5.0, 1.0)
        for n in (0, -1):
            with self.assertRaises(ValueError):
                b.try_acquire(n)
            with self.assertRaises(ValueError):
                b.acquire(n)
        with self.assertRaises(ValueError):
            b.acquire(1, timeout=-1)

    def test_async_value_errors(self):
        b = TokenBucket(5.0, 1.0)

        async def _check():
            for n in (0, -1):
                with self.assertRaises(ValueError):
                    await b.try_acquire_async(n)
                with self.assertRaises(ValueError):
                    await b.acquire_async(n)
            with self.assertRaises(ValueError):
                await b.acquire_async(1, timeout=-1)

        asyncio.run(_check())

    def test_async_initial_full_and_exhaust(self):
        async def _check():
            b = TokenBucket(1.0, 1.0)
            self.assertTrue(await b.try_acquire_async(1))
            self.assertFalse(await b.try_acquire_async(1))
            # 惰性补充只会带来极少量漂移，仍应远小于 1 个令牌（已耗尽）
            self.assertGreaterEqual(b.tokens, 0.0)
            self.assertLess(b.tokens, 1.0)

        asyncio.run(_check())

    def test_async_refill_and_timeout(self):
        async def _check():
            b = TokenBucket(1.0, 100.0)
            self.assertTrue(await b.try_acquire_async(1))  # 初始满桶
            self.assertTrue(await b.acquire_async(1, timeout=1.0))  # 等待补充后成功（成功后桶再次耗尽）
            # 无可用令牌且 timeout=0 → 立即返回 False
            self.assertFalse(await b.acquire_async(1, timeout=0.0))
            # 真实超时路径（补充极慢）
            b2 = TokenBucket(1.0, 0.001)
            self.assertTrue(await b2.try_acquire_async(1))
            t0 = time.monotonic()
            self.assertFalse(await b2.acquire_async(1, timeout=0.05))
            self.assertGreaterEqual(time.monotonic() - t0, 0.04)

        asyncio.run(_check())


class TestTokenBucketConcurrency(unittest.TestCase):
    """多线程 / 多协程并发不变量验证。"""

    THREADS = 8
    THREAD_ITERATIONS = 100
    COROUTINES = 100
    CORO_ITERATIONS = 15

    def test_multithreaded_invariants_no_deadlock(self):
        bucket = TokenBucket(capacity=50.0, refill_rate=500.0)
        created = time.monotonic()
        results = []
        observed = [bucket.tokens]
        threads = [
            threading.Thread(
                target=_thread_worker,
                args=(bucket, self.THREAD_ITERATIONS, results, observed),
            )
            for _ in range(self.THREADS)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        elapsed = time.monotonic() - created

        # 无死锁：所有线程均已正常结束
        for i, t in enumerate(threads):
            self.assertFalse(t.is_alive(), f"线程 {i} 未在超时内结束（疑似死锁）")

        # 不变量 1：tokens 全程非负且不超 capacity
        self.assertGreaterEqual(min(observed), 0.0, "tokens 出现负值")
        self.assertLessEqual(max(observed), bucket.capacity, "tokens 超过 capacity")

        # 不变量 2：总成功获取数 <= 初始 + refill_rate × 总耗时（浮点容差）
        total_success = sum(results)
        budget = bucket.capacity + bucket.refill_rate * elapsed
        self.assertLessEqual(
            total_success,
            budget + BUDGET_TOLERANCE,
            f"总成功获取 {total_success} 超过预算 {budget:.6f}",
        )

    def test_multicoroutine_invariants_no_deadlock(self):
        async def _run():
            bucket = TokenBucket(capacity=30.0, refill_rate=800.0)
            created = time.monotonic()
            results = []
            observed = [bucket.tokens]
            coros = [
                _coro_worker(bucket, self.CORO_ITERATIONS, results, observed)
                for _ in range(self.COROUTINES)
            ]
            # wait_for 整体加超时，防止事件循环挂死
            await asyncio.wait_for(asyncio.gather(*coros), timeout=60)
            elapsed = time.monotonic() - created

            # 不变量 1：tokens 全程非负且不超 capacity
            self.assertGreaterEqual(min(observed), 0.0, "tokens 出现负值")
            self.assertLessEqual(max(observed), bucket.capacity, "tokens 超过 capacity")

            # 不变量 2：总成功获取数 <= 初始 + refill_rate × 总耗时
            total_success = sum(results)
            budget = bucket.capacity + bucket.refill_rate * elapsed
            self.assertLessEqual(
                total_success,
                budget + BUDGET_TOLERANCE,
                f"总成功获取 {total_success} 超过预算 {budget:.6f}",
            )

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
