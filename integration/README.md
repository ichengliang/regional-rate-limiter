# Cross-component integration tests

Black-box tests that exercise the **seams between the three components** — the
things unit tests in each repo can't reach — against real infra:

```
quotamgmt (Java, gRPC)  ──writes config+audit──▶  Postgres  ──read-through──▶  quotaenforcer (Rust, gRPC)
                                                    Redis    ──counters──────▶
```

Python + pytest drive the two gRPC services; `docker-compose` provides isolated
Postgres + Redis.

## What's covered (Stage A — control plane ↔ data plane)

| Test | Seam |
|------|------|
| `test_config_propagation` | A limit created in quotamgmt is enforced by quotaenforcer within the propagation window (Postgres → read-through cache). |
| `test_enforcement` | Full lifecycle: create → check → charge → usage → exhaust/deny → refund, incl. intentional negative overshoot. |
| `test_resolution` | `*` default vs exact-customer override; unconfigured → allow/unlimited. |
| `test_zz_failopen` | Config store (Postgres) down → quotaenforcer **allows** (never blocks); then recovers. |

**Known gaps (documented, not gate-blocking):**
- `test_update_propagates_within_sla` is **xfail** — updating an *already-cached*
  cap is TTL-bound (~30s) until quotaenforcer's deferred audit change-feed poller
  lands (its README / design §5.4). New-limit propagation already meets the SLA.
- **quotaui BFF tier (Stage B) is not yet wired** — the BFF sends only an
  `x-actor` header to its backends and no `authorization: Bearer` token, which
  quotamgmt's auth interceptor requires. That contract gap must be resolved first
  (fix the BFF, or a quotamgmt dev-mode) — see the repo discussion.

## Prerequisites

- Docker + `docker compose` (infra)
- JDK 21 (quotamgmt) and Rust/cargo (quotaenforcer) — the services are built and
  run from the host on first use
- Python 3.11+ (harness)

Ports are isolated so they won't clash with a local dev setup: Postgres `55432`,
Redis `56379`, quotamgmt gRPC `18443`, quotaenforcer gRPC `18444`.

## Run

```sh
./run.sh                    # everything: venv, stubs, infra up/down, tests
KEEP_INFRA=1 ./run.sh       # keep Postgres/Redis up between runs (faster)
./run.sh -k resolution      # a subset (args pass through to pytest)
```

The pytest fixtures (`conftest.py`) own the lifecycle: compose the infra, build
(if needed) + start both services pointed at it, wait for readiness, and tear
down afterwards. Service logs land in `.logs/`.

## Layout

```
integration/
  docker-compose.yml   # isolated Postgres (schema-initialized) + Redis
  requirements.txt     # grpcio, grpcio-tools, protobuf, pytest, requests
  run.sh               # venv + stub-gen + pytest
  conftest.py          # infra/service fixtures, gRPC stubs, auth + CRUD helpers
  tests/               # the suites above
  gen/                 # generated proto stubs (gitignored; run.sh regenerates)
```
