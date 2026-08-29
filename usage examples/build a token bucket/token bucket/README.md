# TokenBucket：并发安全的令牌桶（惰性补充）

一个零依赖、线程安全的令牌桶（Token Bucket）限流实现，同时提供同步与
asyncio 异步接口。核心特点是**惰性补充（lazy refill）**：不启动任何后台线程，
而是在每次访问时按流逝时间计算应补充的令牌数。

- 语言：Python 3.8+（仅使用标准库 `threading` / `asyncio` / `time`）
- 文件：`token_bucket.py`，直接 `from token_bucket import TokenBucket` 即可使用

---

## 1. 算法原理：惰性补充（Lazy Refill）

令牌桶维护一个桶，桶的容量为 `capacity`，桶中最多持有 `capacity` 个令牌；
同时以 `refill_rate` 个/秒的速率持续向桶中补充令牌（不超过桶容量）。

与“后台线程定时补充”的传统做法不同，本实现**不在后台运行任何线程**，而是记录
上次补充时刻 `_last_refill`（基于 `time.monotonic()`，单调且不受系统时间调整影响），
在每次访问令牌桶（读取 `tokens`、`try_acquire`、`acquire` 等）时，先按公式
`补充量 = (当前时刻 - 上次补充时刻) × refill_rate` 计算应补充的令牌数并写入桶中，
再执行本次操作。因此：

- 桶“用多少、算多少”，空闲期间不消耗任何资源；
- 精确性取决于调用频率：调用越频繁，补充越接近连续曲线；
- 系统休眠/挂起后恢复也能正确补足流逝时间对应的令牌。

桶**初始为满**：`TokenBucket(capacity, refill_rate)` 创建后立即拥有 `capacity`
个可用令牌。

## 2. 并发安全保证

所有共享状态（`_tokens`、`_last_refill`）的读写都在 `threading.Lock` 保护的短
临界区内完成，保证多线程并发调用时的互斥与线程安全：

- 同步非阻塞方法 `try_acquire`：加锁、惰性补充、扣减、返回，全程无阻塞等待；
- 同步阻塞方法 `acquire`：使用 `threading.Condition`（基于同一把锁）在令牌不足时
  挂起等待，并支持超时唤醒；
- 异步变体 `try_acquire_async` / `acquire_async`：状态检查与更新同样在
  `threading.Lock` 短临界区内完成（临界区内无 `await`），与同步方法互斥；
  阻塞等待期间**不阻塞事件循环**——`acquire_async` 基于 `time.monotonic()`
  精确计算还需等待的时间，用 `asyncio.sleep` 挂起当前协程，让其他协程继续运行。

因此同一个 `TokenBucket` 实例可以被多个线程、多个协程、乃至线程与协程混用，
无需额外的外部锁。

## 3. API 一览

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| 构造 | `TokenBucket(capacity, refill_rate)` | `capacity`/`refill_rate` 均须 `> 0`，桶初始为满 |
| 属性 | `capacity` | 桶容量（令牌数） |
| 属性 | `refill_rate` | 补充速率（令牌/秒） |
| 属性 | `tokens` | 当前可用令牌数（近似快照，仅用于观察/测试） |
| 同步 | `try_acquire(n=1) -> bool` | 非阻塞；成功返回 `True`，令牌不足立即返回 `False` |
| 同步 | `acquire(n=1, timeout=None) -> bool` | 阻塞等待；超时返回 `False`，`timeout=None` 无限等待 |
| 异步 | `async try_acquire_async(n=1) -> bool` | 非阻塞，语义同 `try_acquire` |
| 异步 | `async acquire_async(n=1, timeout=None) -> bool` | 阻塞等待，不阻塞事件循环；超时返回 `False` |

参数校验：`n < 1` 或 `timeout < 0` 时抛出 `ValueError`；`capacity <= 0` 或
`refill_rate <= 0` 时构造抛出 `ValueError`。

## 4. 同步用法示例

```python
import time
from token_bucket import TokenBucket

# 桶满：初始 5 个令牌，每秒补充 2 个
bucket = TokenBucket(capacity=5, refill_rate=2.0)
print("初始令牌:", bucket.tokens)                    # 5.0

# 非阻塞获取：try_acquire
print(bucket.try_acquire())                          # True
print(bucket.try_acquire(3))                         # True
print(bucket.try_acquire(2))                         # False：令牌不足，不等待

# 阻塞获取：acquire，最多等待 1 秒
start = time.monotonic()
ok = bucket.acquire(2, timeout=1.0)                  # 等待补充后成功
print(f"acquire(2, timeout=1.0): {ok}（等待约 {time.monotonic() - start:.1f} 秒）")

# 超时：返回 False
b2 = TokenBucket(capacity=1, refill_rate=2.0)
b2.try_acquire()                                     # 耗尽
print("acquire(3, timeout=0.1):", b2.acquire(3, timeout=0.1))   # False

# timeout=None：令牌充足时立即成功（无限等待的语义见“参数与超时说明”）
b3 = TokenBucket(capacity=2, refill_rate=1.0)
print("acquire(timeout=None):", b3.acquire())        # True
```

预期输出：

```
初始令牌: 5.0
True
True
False
acquire(2, timeout=1.0): True（等待约 1.0 秒）
acquire(3, timeout=0.1): False
acquire(timeout=None): True
```

## 5. 异步用法示例

```python
import asyncio
from token_bucket import TokenBucket


async def main():
    bucket = TokenBucket(capacity=3, refill_rate=1.0)   # 初始满 3 个
    print("初始令牌:", bucket.tokens)                     # 3.0

    print("try_acquire_async(2):", await bucket.try_acquire_async(2))   # True
    print("try_acquire_async(1):", await bucket.try_acquire_async(1))   # True
    print("try_acquire_async(1):", await bucket.try_acquire_async(1))   # False

    # 带超时的异步阻塞获取：等待期间不阻塞事件循环
    ok = await bucket.acquire_async(1, timeout=2.0)      # 约 1 秒后成功
    print("acquire_async(1, timeout=2.0):", ok)          # True

    # 超时返回 False
    b2 = TokenBucket(capacity=1, refill_rate=0.5)
    await b2.try_acquire_async()                         # 耗尽
    print("acquire_async(2, timeout=0.3):",
          await b2.acquire_async(2, timeout=0.3))        # False

    # timeout=None：无限等待，直到令牌补充足够
    b3 = TokenBucket(capacity=1, refill_rate=1.0)
    await b3.try_acquire_async()                         # 耗尽
    print("acquire_async() 无限等待:", await b3.acquire_async())   # True（约 1 秒）


asyncio.run(main())
```

预期输出：

```
初始令牌: 3.0
try_acquire_async(2): True
try_acquire_async(1): True
try_acquire_async(1): False
acquire_async(1, timeout=2.0): True
acquire_async(2, timeout=0.3): False
acquire_async() 无限等待: True
```

## 6. 参数与超时行为说明

- **`capacity`（桶容量）**：桶中最多能持有的令牌数，必须 `> 0`。它同时是单次
  操作能“立即”获取的上限——例如 `capacity=5` 时，`try_acquire(6)` 永远为
  `False`（即使桶是满的）。桶初始为满。
- **`refill_rate`（补充速率）**：每秒向桶中补充的令牌数，必须 `> 0`。补充按
  `time.monotonic()` 流逝时间惰性计算，不启动后台线程。获取 `n` 个令牌的最短
  等待时间约为 `(n - 当前令牌数) / refill_rate` 秒（若为正）。
- **超时行为**：
  - `timeout=None`：无限等待，直到令牌补充足够（异步版本通过 `asyncio.sleep`
    轮询实现，不阻塞事件循环）。
  - `timeout=0`：等价于一次非阻塞尝试，令牌不足立即返回 `False`。
  - `timeout>0`：最多等待 `timeout` 秒，超时仍未获取到则返回 `False`。
  - `timeout<0`：抛出 `ValueError`。
- **参数校验**：`n < 1`、`timeout < 0` 抛 `ValueError`；`capacity <= 0` 或
  `refill_rate <= 0` 时构造抛 `ValueError`。示例：

```python
from token_bucket import TokenBucket

cases = [
    ("capacity=0", lambda: TokenBucket(0, 1.0)),
    ("refill_rate=0", lambda: TokenBucket(1, 0.0)),
    ("n=0", lambda: TokenBucket(1, 1.0).try_acquire(0)),
    ("n=-1", lambda: TokenBucket(1, 1.0).acquire(-1)),
    ("timeout=-1", lambda: TokenBucket(1, 1.0).acquire(1, timeout=-1)),
]
for label, fn in cases:
    try:
        fn()
        print(f"{label}: 未抛异常（不符合预期）")
    except ValueError as e:
        print(f"{label}: ValueError: {e}")
```

预期输出：

```
capacity=0: ValueError: capacity 必须大于 0
refill_rate=0: ValueError: refill_rate 必须大于 0
n=0: ValueError: n 必须 >= 1
n=-1: ValueError: n 必须 >= 1
timeout=-1: ValueError: timeout 不能为负数
```

---

> 提示：`tokens` 属性返回的是调用时刻的近似快照，仅用于观察与测试；在多线程/多
> 协程环境下，实际可获取量与调用 `try_acquire` / `acquire` 时的瞬时状态为准。
