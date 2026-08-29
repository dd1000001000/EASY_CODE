"""并发安全的令牌桶（Token Bucket）实现。

核心设计：
- 惰性补充（lazy refill）：不启动后台线程，而是在每次访问时根据
  ``time.monotonic()`` 流逝的时间计算应补充的令牌数。
- 线程安全：所有共享状态（_tokens、_last_refill）的读写都由
  ``threading.Lock`` 保护；阻塞式获取使用 ``threading.Condition``
  等待令牌补充，并支持超时。

API 摘要（同步）：
- ``TokenBucket(capacity, refill_rate)``：容量与补充速率（令牌/秒）。
- ``try_acquire(n=1) -> bool``：非阻塞获取，令牌不足立即返回 False。
- ``acquire(n=1, timeout=None) -> bool``：阻塞获取，等待令牌补充，
  超时返回 False。

异步版本（``acquire_async`` / ``try_acquire_async``）见对应方法文档。
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Optional


class TokenBucket:
    """线程安全的令牌桶。

    参数:
        capacity: 桶的最大容量（令牌数），必须 > 0。桶初始为满。
        refill_rate: 每秒补充的令牌数，必须 > 0。

    属性:
        capacity: 桶容量。
        refill_rate: 补充速率（令牌/秒）。
    """

    def __init__(self, capacity: float, refill_rate: float) -> None:
        if capacity <= 0:
            raise ValueError("capacity 必须大于 0")
        if refill_rate <= 0:
            raise ValueError("refill_rate 必须大于 0")
        self.capacity = float(capacity)
        self.refill_rate = float(refill_rate)
        self._tokens: float = self.capacity
        self._last_refill: float = time.monotonic()
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)

    def _refill(self) -> None:
        """按流逝时间补充令牌（调用方必须持有锁）。"""
        now = time.monotonic()
        elapsed = now - self._last_refill
        if elapsed > 0:
            self._tokens = min(
                self.capacity, self._tokens + elapsed * self.refill_rate
            )
            self._last_refill = now

    @property
    def tokens(self) -> float:
        """当前可用令牌数（近似快照，仅用于观察/测试）。"""
        with self._lock:
            self._refill()
            return self._tokens

    def try_acquire(self, n: int = 1) -> bool:
        """非阻塞地尝试获取 n 个令牌。

        参数:
            n: 需要的令牌数，必须 >= 1。

        返回:
            成功获取返回 True；令牌不足返回 False（不等待）。
        """
        if n < 1:
            raise ValueError("n 必须 >= 1")
        with self._lock:
            self._refill()
            if self._tokens >= n:
                self._tokens -= n
                return True
            return False

    def acquire(self, n: int = 1, timeout: Optional[float] = None) -> bool:
        """阻塞获取 n 个令牌，直到令牌补充足够或超时。

        参数:
            n: 需要的令牌数，必须 >= 1。
            timeout: 最大等待秒数；为 None 表示无限等待。

        返回:
            成功获取返回 True；超时仍未获取到返回 False。
        """
        if n < 1:
            raise ValueError("n 必须 >= 1")
        if timeout is not None and timeout < 0:
            raise ValueError("timeout 不能为负数")

        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while True:
                self._refill()
                if self._tokens >= n:
                    self._tokens -= n
                    return True
                # 惰性补充机制下令牌只随时间自然积累，没有显式的 notify 唤醒：
                # 因此始终使用“有界”等待——按缺口计算补充足够令牌所需的时间，
                # 到期自动唤醒重查，避免 timeout=None 时永久休眠（死锁）。
                deficit = n - self._tokens
                wait = deficit / self.refill_rate
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    wait = min(wait, remaining)
                # 下限 1ms，防止极高 refill_rate 时退化为忙等。
                self._cond.wait(max(wait, 1e-3))

    async def try_acquire_async(self, n: int = 1) -> bool:
        """非阻塞地尝试获取 n 个令牌（asyncio 变体）。

        与同步 ``try_acquire`` 语义一致：不等待，成功返回 True，
        令牌不足立即返回 False。状态更新仍在 ``threading.Lock``
        短临界区内完成（无 await），与多线程调用互斥且线程安全。

        参数:
            n: 需要的令牌数，必须 >= 1。
        """
        if n < 1:
            raise ValueError("n 必须 >= 1")
        with self._lock:
            self._refill()
            if self._tokens >= n:
                self._tokens -= n
                return True
            return False

    async def acquire_async(
        self, n: int = 1, timeout: Optional[float] = None
    ) -> bool:
        """异步阻塞获取 n 个令牌，直到令牌补充足够或超时。

        等待期间不阻塞事件循环：不使用阻塞式 ``Condition.wait``，
        而是基于 ``time.monotonic()`` 精确计算还需等待的时间，并用
        ``asyncio.sleep`` 挂起当前协程，让其他协程得以运行。每次唤醒
        后都在 ``threading.Lock`` 短临界区内做状态检查/更新（无 await），
        与同步方法共享惰性补充逻辑并保证互斥。

        参数:
            n: 需要的令牌数，必须 >= 1。
            timeout: 最大等待秒数；为 None 表示无限等待。

        返回:
            成功获取返回 True；超时仍未获取到返回 False。
        """
        if n < 1:
            raise ValueError("n 必须 >= 1")
        if timeout is not None and timeout < 0:
            raise ValueError("timeout 不能为负数")

        # 先做一次非阻塞尝试，避免空等。
        if await self.try_acquire_async(n):
            return True
        if timeout == 0:
            return False

        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            # 在短临界区内精确计算还需等待的时间。
            with self._lock:
                self._refill()
                deficit = n - self._tokens
            if deficit <= 0:
                # 防御性重试：可能被其他线程/协程抢占，重新进入循环。
                if await self.try_acquire_async(n):
                    return True
                continue
            wait = deficit / self.refill_rate
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                if wait > remaining:
                    wait = remaining
            await asyncio.sleep(wait)
            if await self.try_acquire_async(n):
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
