# Regional Rate Limiter

Design for a general-purpose, regional rate limiting service: per-customer quotas
enforced with `check` / `charge` / `refund` over fixed-window counters, built to
be low-latency, scalable, highly available, and **fail-open**.

## Documents

- **[High-level design](regional-rate-limiter-design.md)** — the system design:
  requirements, API, data model, architecture, thundering-herd handling,
  regional model, degradation, and resolved decisions. Start here.

Component ("next level") designs:

- **[quotamgmt](design/quotamgmt.md)** — control plane: config + audit source of
  truth (Postgres), CRUD API, and config propagation to the data plane.
- **[quotaenforcer](design/quotaenforcer.md)** — data plane: the hot path
  (Client SDK → stateless service → Redis counters), Lua ops, sharding,
  fail-open, and degradation.
- **[quotaui](design/quotaui.md)** — internal admin UI: config management, live
  usage, manual ops, and audit browsing (a control-plane client, never in the
  hot path).

## Schemas

- **[schema/postgres.sql](schema/postgres.sql)** — control-plane config + audit DDL.
- **[schema/redis_scripts.lua](schema/redis_scripts.lua)** — data-plane atomic
  charge / refund / check scripts.

## Repository layout (monorepo)

Shared API contracts live in `proto/`; each component is implemented in its own
language and generates code from those protos.

```
proto/            shared gRPC contracts (see proto/README.md)
quotamgmt/        control plane   — Java   (design/quotamgmt.md)
quotaenforcer/    data plane      — Rust   (design/quotaenforcer.md)
quotaui/          internal admin  — TypeScript SPA + BFF (design/quotaui.md)
schema/           Postgres DDL + Redis Lua
```

Each component directory has its own `README.md` with build/run instructions.
The proto contracts in `proto/` are the coordination point — change them there
and each component regenerates.

## Running on GCP

A full end-to-end deployment lives in **[`gcp/`](gcp/)** (GKE + private-IP Cloud
SQL and Memorystore, 3 replicas per service behind external load balancers,
enforcer HPA 3→10). See [`gcp/README.md`](gcp/README.md) to provision it and
[`gcp/MANUAL_TESTING.md`](gcp/MANUAL_TESTING.md) for a manual walkthrough.

> **The system is currently live on GCP** (project `quis-8-9c379`, region
> `us-central1`). Current external endpoints:
>
> | Service | Endpoint |
> |---------|----------|
> | quotamgmt (gRPC) | `34.70.28.177:8443` |
> | quotaenforcer (gRPC) | `34.42.142.148:8444` |
> | quotaui (HTTP) | http://34.55.97.231/ |
>
> LoadBalancer IPs can change across redeploys — the test runner auto-discovers
> them from the cluster, so you don't need to hard-code these.

### Run the automated e2e tests against the live deployment

The suite in [`gcp/e2e/`](gcp/e2e/) drives the deployed load balancers exactly as
a real client would. With `kubectl` pointed at the cluster it auto-discovers the
endpoints:

```sh
# one-time: point kubectl at the cluster
gcloud container clusters get-credentials quota-demo-gke --region us-central1 --project quis-8-9c379

cd gcp/e2e
./run.sh                 # core suite (auto-discovers LB IPs; creates a venv + proto stubs)
./run.sh -k enforcement  # a subset (pytest args pass through)
./run.sh -m slow         # opt-in: drive load to trigger enforcer HPA scale-up
```

To target endpoints explicitly instead of auto-discovery, export them (the values
`gcp/scripts/50-endpoints.sh` prints):

```sh
export QUOTAMGMT_ADDR=34.70.28.177:8443
export QUOTAENFORCER_ADDR=34.42.142.148:8444
export QUOTAUI_URL=http://34.55.97.231
export QUOTAMGMT_TOKEN=quota-demo-admin-token
cd gcp/e2e && ./run.sh
```

The suite covers reachability + fail-open, control-plane CRUD and resolution, the
full check/charge/refund/usage lifecycle, new-limit propagation, the quotaui BFF
(auth / RBAC / live usage), and HA (≥3 ready replicas + enforcer HPA 3→10) — all
**17 tests currently pass** against the live cluster.
