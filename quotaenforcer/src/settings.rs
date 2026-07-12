//! Environment-driven configuration for the service.
//!
//! Postgres uses the standard `PG*` variables (matching `libpq`), so the repo's
//! `.env` (`PGUSER` / `PGPASSWORD` / `PGDATABASE`) works as-is for local runs.

use std::net::SocketAddr;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Settings {
    /// gRPC listen address.
    pub listen_addr: SocketAddr,
    /// Redis connection URL.
    pub redis_url: String,

    // Postgres (quotamgmt config source).
    pub pg_host: String,
    pub pg_port: u16,
    pub pg_user: String,
    pub pg_password: String,
    pub pg_database: String,

    /// TTL grace pad so late charges/refunds land on the right key (design §4.5).
    pub ttl_grace_secs: i64,

    /// Config-cache TTLs (design §5.3, §8.4).
    pub config_positive_ttl: Duration,
    pub config_negative_ttl: Duration,
    pub config_ttl_jitter: Duration,

    /// Max keys per `CheckQuotaBatch` (validation cap, design §2.2, §10).
    pub max_batch_size: usize,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Settings {
    /// Load from the environment, falling back to local-dev defaults.
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            listen_addr: env_or("QUOTAENFORCER_ADDR", "0.0.0.0:8444").parse()?,
            redis_url: env_or("REDIS_URL", "redis://127.0.0.1:6379"),
            pg_host: env_or("PGHOST", "localhost"),
            pg_port: env_or("PGPORT", "5432").parse()?,
            pg_user: env_or("PGUSER", "postgres"),
            pg_password: env_or("PGPASSWORD", "postgres"),
            pg_database: env_or("PGDATABASE", "quota"),
            ttl_grace_secs: 5,
            config_positive_ttl: Duration::from_secs(30),
            config_negative_ttl: Duration::from_secs(5),
            config_ttl_jitter: Duration::from_secs(5),
            max_batch_size: 100,
        })
    }
}
