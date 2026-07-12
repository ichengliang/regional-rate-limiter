# quotaenforcer (data plane)

Rust implementation of the data-plane `quotaenforcer.v1.RateLimiter` gRPC service
(the hot path: `CheckQuota` / `CheckQuotaBatch` / `Charge` / `Refund` / `GetUsage`).
Design: [`design/quotaenforcer.md`](../design/quotaenforcer.md).

This is **scaffolding**: the server binds and serves the generated gRPC contract,
but every method returns `UNIMPLEMENTED`. The hot-path logic — Redis Lua ops,
config cache (read-through from `quotamgmt`), fail-open, sharding, and `window_id`
math — is specified in `design/quotaenforcer.md` and is **not yet implemented**.

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

Listens on `0.0.0.0:8444` by default. Override with the `QUOTAENFORCER_ADDR`
environment variable, e.g. `QUOTAENFORCER_ADDR=127.0.0.1:9000 cargo run`.
