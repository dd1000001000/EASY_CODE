# testing/ — Test Infrastructure

Black-box test infrastructure for the exchange matching server (`../server.py`).
All tests speak only the wire protocol (TCP, length-prefixed XML); they never
reach into the server's memory.

## Functional tests

| File               | Purpose                                                            |
|--------------------|--------------------------------------------------------------------|
| `functional_test.py` | 23 black-box tests covering the README examples and edge cases   |
| `client.py`          | shared client helpers (request builders, response parsing)       |
| `run_all.py`         | starts `server.py`, runs every functional test, stops the server |

Coverage includes:

- README `<create>` example and the full README matching example (orders 1–7)
- insufficient-funds rejection and short-sale (insufficient shares) rejection
- cancel refunds money (buy) / returns shares (sell)
- partial execution, partial execution then cancel
- price priority and time (arrival) priority matching
- invalid account, duplicate account, invalid transaction id
- symbol creation errors and create-children processing order
- symbol creation adding more shares to an existing account
- atomicity: a match consistently updates both accounts
- equal-limit-price crossing, fractional balances/amounts/limits (exact
  decimal arithmetic), several requests on one TCP connection

### Run

```bash
# from the repo root (auto starts/stops the server):
python testing/run_all.py

# or with a server already running on :12345:
python testing/functional_test.py
```

Expected output ends with `ALL FUNCTIONAL TESTS PASSED` (exit code 0).

## Scalability tests

| File        | Purpose                                                            |
|-------------|--------------------------------------------------------------------|
| `load_test.py` | concurrent-client throughput benchmark (orders/sec per concurrency level) |

See `load_test.py --help` and `../writeup/report.pdf` for methodology and
results.
