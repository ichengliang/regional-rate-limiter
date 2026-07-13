//! Redis counter store (design §4).
//!
//! Holds exactly one key per active `(customer, limit, window)` and runs the
//! three atomic Lua ops server-side. The script bodies are reproduced from
//! `schema/redis_scripts.lua` — **that file is the source of truth** (design
//! §4.2); keep the two in sync.
//!
//! [`redis::Script`] gives us the `EVALSHA` → `EVAL`-on-`NOSCRIPT` fallback for
//! free (design §4.2): it tries `EVALSHA`, and on a `NOSCRIPT` reply (e.g. after a
//! shard restart flushed its script cache) it transparently `EVAL`s the body and
//! re-caches it.

use redis::aio::ConnectionManager;
use redis::{RedisError, Script};

/// CHARGE — always applies; `remaining` may go negative by design (design §4.2).
/// `KEYS[1]`=counter `ARGV[1]`=cost `ARGV[2]`=limit `ARGV[3]`=ttl_seconds → remaining
const CHARGE_SRC: &str = r#"
local consumed = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
return tonumber(ARGV[2]) - consumed
"#;

/// REFUND — floored at 0; `INCRBY` not `SET` so the window TTL is PRESERVED
/// (design §4.2). `KEYS[1]`=counter `ARGV[1]`=amount `ARGV[2]`=limit → remaining
const REFUND_SRC: &str = r#"
local consumed = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if consumed < 0 then
    redis.call('INCRBY', KEYS[1], -consumed)
    consumed = 0
end
return tonumber(ARGV[2]) - consumed
"#;

/// CHECK — read-only; a missing key is `consumed = 0` (full quota, a safe
/// default). `KEYS[1]`=counter `ARGV[1]`=limit `ARGV[2]`=cost → {allowed(1/0), remaining}
const CHECK_SRC: &str = r#"
local consumed  = tonumber(redis.call('GET', KEYS[1]) or '0')
local remaining = tonumber(ARGV[1]) - consumed
return { (remaining >= tonumber(ARGV[2])) and 1 or 0, remaining }
"#;

/// Build the counter key: `rl:{<svc>|<cust>|<rlid>}:cnt:<window_id>`.
///
/// The `{...}` is a Redis Cluster hash tag — only those bytes are hashed to a
/// slot, so every window of one limit lands on the same shard (design §4.1, §4.3).
pub fn counter_key(svc: &str, cust: &str, rlid: &str, window_id: &str) -> String {
    format!("rl:{{{svc}|{cust}|{rlid}}}:cnt:{window_id}")
}

/// Result of a read-only check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckResult {
    pub allowed: bool,
    pub remaining: i64,
}

#[derive(Clone)]
pub struct RedisStore {
    conn: ConnectionManager,
    charge: Script,
    refund: Script,
    check: Script,
}

impl RedisStore {
    /// Connect and pre-load the scripts. `ConnectionManager` is a cloneable,
    /// multiplexed connection that reconnects on its own (design §8.3: bounded,
    /// reused connections — never connection-per-op).
    pub async fn connect(redis_url: &str) -> Result<Self, RedisError> {
        let client = redis::Client::open(redis_url)?;
        let conn = ConnectionManager::new(client).await?;
        let store = Self {
            conn,
            charge: Script::new(CHARGE_SRC),
            refund: Script::new(REFUND_SRC),
            check: Script::new(CHECK_SRC),
        };
        // Prime the script cache; harmless if it races another server (design §4.2).
        store.load_scripts().await?;
        Ok(store)
    }

    async fn load_scripts(&self) -> Result<(), RedisError> {
        let mut conn = self.conn.clone();
        self.charge.prepare_invoke().load_async(&mut conn).await?;
        self.refund.prepare_invoke().load_async(&mut conn).await?;
        self.check.prepare_invoke().load_async(&mut conn).await?;
        Ok(())
    }

    /// CHARGE: apply `cost`, set the jittered TTL once on a brand-new key, return
    /// `remaining` (may be negative). See design §3.2.
    pub async fn charge(
        &self,
        key: &str,
        cost: i64,
        limit: i64,
        ttl_secs: i64,
    ) -> Result<i64, RedisError> {
        let mut conn = self.conn.clone();
        self.charge
            .key(key)
            .arg(cost)
            .arg(limit)
            .arg(ttl_secs)
            .invoke_async(&mut conn)
            .await
    }

    /// REFUND: credit `amount` back, floored at 0 (TTL preserved), return
    /// `remaining`. See design §3.3.
    pub async fn refund(&self, key: &str, amount: i64, limit: i64) -> Result<i64, RedisError> {
        let mut conn = self.conn.clone();
        self.refund
            .key(key)
            .arg(amount)
            .arg(limit)
            .invoke_async(&mut conn)
            .await
    }

    /// CHECK (read-only): advisory, non-reserving. See design §3.1.
    pub async fn check(&self, key: &str, limit: i64, cost: i64) -> Result<CheckResult, RedisError> {
        let mut conn = self.conn.clone();
        let (allowed, remaining): (i64, i64) = self
            .check
            .key(key)
            .arg(limit)
            .arg(cost)
            .invoke_async(&mut conn)
            .await?;
        Ok(CheckResult {
            allowed: allowed == 1,
            remaining,
        })
    }

    /// Raw consumed for the read-only live-usage endpoint (design §2.2). Missing
    /// key => 0.
    pub async fn consumed(&self, key: &str) -> Result<i64, RedisError> {
        let mut conn = self.conn.clone();
        let v: Option<i64> = redis::cmd("GET").arg(key).query_async(&mut conn).await?;
        Ok(v.unwrap_or(0))
    }
}
