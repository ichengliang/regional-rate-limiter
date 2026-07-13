//! Read-through config cache over `quotamgmt`'s Postgres config (design §5).
//!
//! The cap is **never** in Redis — it comes from `limit_config`, resolved with
//! the exact-then-`*`-default query (design §5.1, `schema/postgres.sql`) and
//! cached per concrete `(svc, cust, rlid)` with a jittered TTL. Misses that match
//! no row are cached as *negative* (unconfigured → allow, §5.3). When Postgres is
//! unreachable we serve last-known-good, else fail open (§5.5).
//!
//! Scope note: refresh here is TTL-driven. The audit change-feed poller (§5.4)
//! and cross-instance shared cache are deferred (see README).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use deadpool_postgres::{Pool, Runtime};
use tokio_postgres::NoTls;
use tracing::warn;

use crate::pb::common::TimeUnit;
use crate::settings::Settings;

/// A resolved cap for a `(svc, cust, rlid)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cap {
    pub limit_value: i64,
    pub time_unit: TimeUnit,
}

/// Outcome of resolving a key against config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolved {
    /// A row matched (exact or `*` default): enforce this cap.
    Configured(Cap),
    /// No row matched, or config was unreachable with no last-known-good:
    /// unconfigured → allow / unlimited (design §5.3, §5.5).
    Unconfigured,
}

struct Entry {
    resolved: Resolved,
    expires_at: Instant,
}

type Key = (String, String, String);

pub struct ConfigCache {
    pool: Pool,
    cache: Mutex<HashMap<Key, Entry>>,
    positive_ttl: Duration,
    negative_ttl: Duration,
    jitter: Duration,
}

impl ConfigCache {
    /// Build the Postgres pool from `settings` and an empty cache.
    pub fn connect(settings: &Settings) -> Result<Self, deadpool_postgres::CreatePoolError> {
        let mut cfg = deadpool_postgres::Config::new();
        cfg.host = Some(settings.pg_host.clone());
        cfg.port = Some(settings.pg_port);
        cfg.user = Some(settings.pg_user.clone());
        cfg.password = Some(settings.pg_password.clone());
        cfg.dbname = Some(settings.pg_database.clone());
        let pool = cfg.create_pool(Some(Runtime::Tokio1), NoTls)?;
        Ok(Self {
            pool,
            cache: Mutex::new(HashMap::new()),
            positive_ttl: settings.config_positive_ttl,
            negative_ttl: settings.config_negative_ttl,
            jitter: settings.config_ttl_jitter,
        })
    }

    /// Resolve the cap for `(svc, cust, rlid)`, never erroring: any failure
    /// resolves to a value the hot path can act on (fail-open, design §5.5).
    pub async fn resolve(&self, svc: &str, cust: &str, rlid: &str) -> Resolved {
        let key = (svc.to_string(), cust.to_string(), rlid.to_string());

        if let Some(hit) = self.get_fresh(&key) {
            return hit;
        }

        match self.query_db(svc, cust, rlid).await {
            Ok(resolved) => {
                self.store(key, resolved);
                resolved
            }
            Err(e) => {
                // Postgres unreachable: serve last-known-good (even if expired),
                // else allow (unconfigured). Design §5.5.
                warn!(error = %e, svc, cust, rlid, "config lookup failed; failing open");
                self.get_any(&key).unwrap_or(Resolved::Unconfigured)
            }
        }
    }

    fn get_fresh(&self, key: &Key) -> Option<Resolved> {
        let cache = self.cache.lock().unwrap();
        cache
            .get(key)
            .filter(|e| e.expires_at > Instant::now())
            .map(|e| e.resolved)
    }

    /// Last-known-good regardless of expiry — for the config-unreachable path.
    fn get_any(&self, key: &Key) -> Option<Resolved> {
        let cache = self.cache.lock().unwrap();
        cache.get(key).map(|e| e.resolved)
    }

    fn store(&self, key: Key, resolved: Resolved) {
        let base = match resolved {
            Resolved::Configured(_) => self.positive_ttl,
            Resolved::Unconfigured => self.negative_ttl,
        };
        // Jittered TTL so a hot entry doesn't expire everywhere at once (§5.3, §8.4).
        let jitter = if self.jitter.is_zero() {
            Duration::ZERO
        } else {
            Duration::from_millis(rand::random::<u64>() % (self.jitter.as_millis() as u64 + 1))
        };
        let mut cache = self.cache.lock().unwrap();
        cache.insert(
            key,
            Entry {
                resolved,
                expires_at: Instant::now() + base + jitter,
            },
        );
    }

    /// The exact-then-default resolution query (design §5.1, `schema/postgres.sql`).
    async fn query_db(
        &self,
        svc: &str,
        cust: &str,
        rlid: &str,
    ) -> Result<Resolved, Box<dyn std::error::Error + Send + Sync>> {
        let client = self.pool.get().await?;
        let row = client
            .query_opt(
                "SELECT limit_value, time_unit::text \
                   FROM limit_config \
                  WHERE service_name = $1 AND rate_limit_id = $2 \
                    AND customer_id IN ($3, '*') \
                  ORDER BY (customer_id = '*') \
                  LIMIT 1",
                &[&svc, &rlid, &cust],
            )
            .await?;

        Ok(match row {
            Some(row) => {
                let limit_value: i64 = row.get(0);
                let unit_text: String = row.get(1);
                Resolved::Configured(Cap {
                    limit_value,
                    time_unit: parse_time_unit(&unit_text),
                })
            }
            None => Resolved::Unconfigured,
        })
    }
}

/// Map the Postgres `time_unit` enum text to the proto `TimeUnit`.
fn parse_time_unit(s: &str) -> TimeUnit {
    match s {
        "MINUTE" => TimeUnit::Minute,
        "DAY" => TimeUnit::Day,
        "MONTH" => TimeUnit::Month,
        _ => TimeUnit::Unspecified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_time_units() {
        assert_eq!(parse_time_unit("MINUTE"), TimeUnit::Minute);
        assert_eq!(parse_time_unit("DAY"), TimeUnit::Day);
        assert_eq!(parse_time_unit("MONTH"), TimeUnit::Month);
        assert_eq!(parse_time_unit("bogus"), TimeUnit::Unspecified);
    }
}
