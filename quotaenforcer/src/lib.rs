//! `quotaenforcer` — data plane of the Regional Rate Limiter.
//!
//! This crate implements the **stateless RL Service tier** from
//! `design/quotaenforcer.md`: the gRPC `RateLimiter` service that resolves a cap
//! from config, computes the `window_id` + jittered TTL, and dispatches the three
//! atomic Redis Lua ops (charge / refund / check).
//!
//! Module map:
//! - [`window`]  — `window_id` / `reset_at` / `window_remaining` math (§4.6) + jittered TTL (§4.5).
//! - [`store`]   — Redis counter store, the three Lua scripts via `EVALSHA` (§4.2).
//! - [`config`]  — read-through config cache over `quotamgmt`'s Postgres (§5).
//! - [`service`] — the gRPC `RateLimiter` implementation tying it together (§3).
//! - [`settings`]— environment-driven configuration.
//!
//! See the crate `README.md` for what is intentionally out of scope here (the
//! in-producer Client SDK, change-feed polling, Redis Cluster topology).

// Generated proto code. The module names MUST be `quotaenforcer` and `quota` at
// the crate root: prost emits cross-package references (quotaenforcer.v1 ->
// quota.common.v1) as paths relative to the crate root, so the module hierarchy
// has to mirror the proto package hierarchy.
pub mod quotaenforcer {
    pub mod v1 {
        tonic::include_proto!("quotaenforcer.v1");
    }
}
pub mod quota {
    pub mod common {
        pub mod v1 {
            tonic::include_proto!("quota.common.v1");
        }
    }
}

/// Encoded protobuf `FileDescriptorSet` (emitted by `build.rs`) backing gRPC
/// server reflection.
pub const FILE_DESCRIPTOR_SET: &[u8] =
    tonic::include_file_descriptor_set!("quotaenforcer_descriptor");

pub mod config;
pub mod error;
pub mod service;
pub mod settings;
pub mod store;
pub mod window;

/// Convenient aliases for the generated proto types.
pub mod pb {
    pub use crate::quota::common::v1 as common;
    pub use crate::quotaenforcer::v1::*;
}
