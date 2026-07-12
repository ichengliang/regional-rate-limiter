# Manual testing — `quotaenforcer`

How to bring up the data-plane server locally and exercise every RPC by hand.
The automated tests are separate (`cargo test`); this is for eyeballing real
gRPC responses.

## Prerequisites

| Requirement | Why | Check |
|-------------|-----|-------|
| **Redis** (≥ 6) running | Counter store (charge/refund/check) | `redis-cli ping` → `PONG` |
| **Postgres** (≥ 14) running, with the schema applied | Source of the caps the enforcer resolves | `psql -c '\dt'` shows `limit_config`, `limit_config_audit`, `service` |
| **Rust** toolchain (`cargo`) + **protoc** | Build the server (protos compiled at build time) | `cargo --version`, `protoc --version` |
| **grpcurl** | Send gRPC calls by hand | `grpcurl --version` |

- Postgres schema, if not already loaded:
  ```
  psql "$PGDATABASE" -f ../schema/postgres.sql
  ```
### Installing `grpcurl` and putting it on `PATH`

Download a prebuilt release (Linux x86_64 shown; pick your OS/arch from the
[releases page](https://github.com/fullstorydev/grpcurl/releases)):

```bash
VERSION=1.9.1
curl -sSL -o /tmp/grpcurl.tar.gz \
  "https://github.com/fullstorydev/grpcurl/releases/download/v${VERSION}/grpcurl_${VERSION}_linux_x86_64.tar.gz"
tar -xzf /tmp/grpcurl.tar.gz -C /tmp grpcurl
```

Then put it on `PATH` one of these ways:

```bash
# A) system-wide (needs sudo) — simplest, works in every new shell:
sudo mv /tmp/grpcurl /usr/local/bin/

# B) per-user, no sudo — add ~/.local/bin to PATH permanently:
mkdir -p ~/.local/bin && mv /tmp/grpcurl ~/.local/bin/
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # then: source ~/.bashrc
```

Verify: `grpcurl --version` prints the version.

If you have Go instead: `go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest`
installs to `$(go env GOPATH)/bin` — add that dir to `PATH` the same way.

**Don't want to touch `PATH`?** Point the script straight at the binary:
`GRPCURL=/tmp/grpcurl ./scripts/manual_test.sh`.

### Connection settings

The server reads standard env vars (local-dev defaults in parentheses). The repo
`.env` already sets the Postgres ones.

| Var | Default | Purpose |
|-----|---------|---------|
| `QUOTAENFORCER_ADDR` | `0.0.0.0:8444` | gRPC listen address |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Counter store |
| `PGHOST` / `PGPORT` | `localhost` / `5432` | Config Postgres |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `postgres` / `postgres` / `quota` | Postgres credentials |

## 1. Start the server

```bash
cd quotaenforcer
PGUSER=postgres PGPASSWORD='<your-password>' PGDATABASE=quota \
QUOTAENFORCER_ADDR=127.0.0.1:8444 \
cargo run
```

Expect three log lines: `connected to counter store`, `config cache pool ready`,
`quotaenforcer listening addr=127.0.0.1:8444`. The server exposes **gRPC server
reflection**, so `grpcurl` needs no local `.proto` files:

```bash
grpcurl -plaintext 127.0.0.1:8444 list                        # -> quotaenforcer.v1.RateLimiter
grpcurl -plaintext 127.0.0.1:8444 list quotaenforcer.v1.RateLimiter  # -> the 5 methods
```

## 2. Seed some config

The enforcer only limits what `quotamgmt`'s config table defines; everything else
is treated as *unconfigured → allow*. Seed the example limits:

```bash
psql "$PGDATABASE" -f scripts/seed.sql
```

This creates (service `search-svc`):

| customer_id | rate_limit_id | limit | window |
|-------------|---------------|-------|--------|
| `cust_42` | `requests_per_min` | 1000 | MINUTE (exact override) |
| `*` | `requests_per_min` | 100 | MINUTE (default) |
| `org_9` | `org_tokens_per_day` | 50000 | DAY |

## 3. Run the test cases

The script drives all five RPCs and prints the expected result before each call:

```bash
# seed + run in one shot (needs PG* env for the seed step):
SEED=1 ./scripts/manual_test.sh

# already seeded — just run the calls:
./scripts/manual_test.sh

# grpcurl not on PATH, or a different address:
GRPCURL=/path/to/grpcurl ADDR=127.0.0.1:8444 ./scripts/manual_test.sh
```

### Cases covered

| # | Case | Expected |
|---|------|----------|
| 1 | CheckQuota, fresh window | `allowed=true, remaining=1000, limit=1000` |
| 2 | Charge cost 3 | `remaining=997` |
| 3 | GetUsage (quotaui read path) | `consumed=3, remaining=997, configured=true` |
| 4 | Refund 3 | `remaining=1000` |
| 5 | Charge, cost defaults to 1 | `remaining=999` |
| 6 | `*` default for unlisted customer | `limit=100` |
| 7 | Exact row wins over default | `limit=1000` |
| 8 | Charge past cap | `remaining` goes negative (by design) |
| 9 | CheckQuota after overshoot | `allowed=false` (omitted), remaining negative → 429 at producer |
| 10 | CheckQuotaBatch (minute + day) | two results, **different `resetAt`** |
| 11 | Unconfigured limit | `allowed=true, limit=0` (unlimited) |
| 12 | GetUsage, unconfigured | `configured=false` |
| 13 | Missing key | `ERROR InvalidArgument` |
| 14 | Negative cost | `ERROR InvalidArgument` |

### Single ad-hoc call

```bash
grpcurl -plaintext -d '{
  "key": {"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},
  "cost": 1
}' 127.0.0.1:8444 quotaenforcer.v1.RateLimiter/CheckQuota
```

## Reading the output

`grpcurl` omits proto3 zero/false fields, so a **missing** field means the
default:

- no `allowed` field ⇒ `allowed=false`
- `remaining`/`limit`/`consumed` absent ⇒ `0`
- `{}` on GetUsage ⇒ `consumed=0, remaining=0, limit=0, configured=false`

Non-zero/true values always print.

## Troubleshooting

- **Config-backed cases return `limit:0` / everything allowed.** The cap isn't in
  Postgres. Re-seed (`SEED=1 ./scripts/manual_test.sh`). The server caches config
  for ~30 s, so allow a moment after seeding, or restart it for an instant clean
  cache. Note the local DB may be shared with other components/tests that mutate
  `limit_config`.
- **`remaining` keeps dropping across runs.** `Charge` accumulates within the
  current window. The script resets the `search-svc` counters at startup; to reset
  by hand: `redis-cli --scan --pattern 'rl:{search-svc|*' | xargs -r redis-cli del`.
- **`connection refused`.** Server isn't up, or `ADDR` doesn't match
  `QUOTAENFORCER_ADDR`.
- **`grpcurl: command not found`.** Install it or pass `GRPCURL=/path/to/grpcurl`.
