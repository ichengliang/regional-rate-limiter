# quotaenforcer (data plane)

Rust implementation of the data-plane `quotaenforcer.v1.RateLimiter` gRPC service
(the hot path: `CheckQuota` / `CheckQuotaBatch` / `Charge` / `Refund` / `GetUsage`).
Design: [`design/quotaenforcer.md`](../design/quotaenforcer.md).

This implements the **stateless RL Service tier**: resolve the cap from config →
compute the `window_id` + jittered TTL → run the single-key atomic Redis Lua op →
map to the typed response (design §3). Unconfigured limits **allow / unlimited**;
config-unavailability serves last-known-good, else allows (fail-open, §5.5).

## Module map

| Module | Design | Responsibility |
|--------|--------|----------------|
| `window`   | §4.6, §4.5 | `window_id` / `reset_at` / `window_remaining` (UTC, calendar-aware month) + strictly-additive jittered TTL. |
| `store`    | §4.2, §4.1 | Redis counter store; the three Lua scripts via `EVALSHA` with `NOSCRIPT`→`EVAL` fallback; hash-tagged keys. |
| `config`   | §5 | Read-through config cache over `quotamgmt`'s Postgres: exact-then-`*`-default resolution, negative caching, jittered TTL, fail-open. |
| `service`  | §3 | The gRPC `RateLimiter` implementation tying it together. |
| `settings` | — | Environment-driven configuration. |
| `error`    | §6.3, §10 | Error → gRPC `Status` mapping (store failure → `UNAVAILABLE`). |

The Lua script bodies in `store.rs` are reproduced from
[`schema/redis_scripts.lua`](../schema/redis_scripts.lua) — **that file is the
source of truth**; keep the two in sync.

## Out of scope here (deferred / producer-side)

Per the design, several pieces live in the producer or are opt-in; they are **not**
implemented in this service tier and are noted for follow-up:

- **Client SDK** (design §6): the in-producer deadline (5 ms), circuit breaker,
  connection pool, batch coalescing, and token-lease. The deadline and the final
  fail-open *synthesis* are the SDK's job; this tier surfaces `UNAVAILABLE` /
  `INVALID_ARGUMENT` for the SDK to fail open on.
- **Audit change-feed poller** (§5.4): cache refresh here is TTL-driven; the
  `limit_config_audit` poll / `LISTEN.NOTIFY` push is future work.
- **Phase-offset** window variant (§4.6) and **Redis Cluster** topology (§4.3):
  keys are already hash-tagged (`rl:{svc|cust|rlid}:cnt:<window_id>`), so a
  cluster-aware client is a drop-in; the current client targets a single endpoint.

## Configuration

Environment variables (local-dev defaults in parentheses):

| Var | Default | Purpose |
|-----|---------|---------|
| `QUOTAENFORCER_ADDR` | `0.0.0.0:8444` | gRPC listen address. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Counter store. |
| `PGHOST` / `PGPORT` | `localhost` / `5432` | quotamgmt config Postgres. |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `postgres` / `postgres` / `quota` | Postgres credentials. |

In production the Postgres user should be a dedicated **read-only** `quotaenforcer`
role — the data plane only ever reads config.

## Build

```
cargo build
```

The shared protos in [`../proto`](../proto) are compiled at build time by
[`build.rs`](build.rs) via `tonic-build` (`protoc` must be on `PATH`).

## Run

```
cargo run
```

Requires a reachable Redis and Postgres (schema from
[`../schema/postgres.sql`](../schema/postgres.sql)). The server exposes **gRPC
server reflection**, so clients like `grpcurl` can call it without local `.proto`
files.

## Manual verification

See [`MANUAL_TESTING.md`](MANUAL_TESTING.md) for the full walkthrough
(prerequisites — Redis, Postgres, `grpcurl` — setup, and every case).

[`scripts/manual_test.sh`](scripts/manual_test.sh) drives all five RPCs over gRPC
(via reflection) and prints the expected result before each case — happy path,
`*`-default vs exact resolution, negative overshoot → deny, batch, unconfigured =
allow, and the validation errors. It needs `grpcurl` on `PATH` (or `GRPCURL=…`).

```
# one-time config seed (uses PG* env from ../.env), then run every case:
SEED=1 ./scripts/manual_test.sh
# subsequent runs (already seeded):
./scripts/manual_test.sh
```

Config lives in [`scripts/seed.sql`](scripts/seed.sql). A single ad-hoc call:

```
grpcurl -plaintext -d '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":1}' \
  127.0.0.1:8444 quotaenforcer.v1.RateLimiter/CheckQuota
```

Note: `grpcurl` omits proto3 zero/false fields, so a missing field means the
default (e.g. no `allowed` ⇒ `allowed=false`; `{}` ⇒ all zero/false).

## Test

Unit tests (window math, validation, enum parsing) need no infra:

```
cargo test --lib
```

Integration tests exercise a **real local Redis and Postgres** and cover the
correctness/concurrency cases from design §13 (charge→negative, refund
floor-at-0 with TTL preserved, TTL-set-once, missing-key=0, bounded concurrent
overshoot, exact-vs-`*` resolution, unconfigured=allow). Provide the infra via env:

```
PGPASSWORD='…' PGUSER=postgres PGDATABASE=quota cargo test
```

If Redis or Postgres is unreachable, the integration tests print `SKIP` and pass,
so the suite still runs without the infra.
