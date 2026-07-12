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
