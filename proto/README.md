# proto — shared API contracts

Source of truth for the gRPC contracts shared across components. Each component
generates code from these with its own toolchain (Java via Gradle, Rust via
tonic-build, TypeScript via `@grpc/proto-loader`).

```
quota/common/v1/common.proto      shared types: TimeUnit, LimitKey
quotamgmt/v1/limit_admin.proto    control-plane API  (quotamgmt.v1.LimitAdmin)
quotaenforcer/v1/rate_limiter.proto  data-plane API  (quotaenforcer.v1.RateLimiter)
```

`LimitKey` and `TimeUnit` live in `quota.common.v1` so both services share one
definition (the design docs describe them under quotamgmt; they are hoisted here
to avoid duplication).

Optional: `buf lint` / `buf breaking` use `buf.yaml`. Not required to build any
component.
