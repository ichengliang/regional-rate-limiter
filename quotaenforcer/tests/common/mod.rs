//! Shared helpers for the integration tests. These exercise the real local Redis
//! and Postgres (env `REDIS_URL`, `PG*`). If a dependency is unreachable the
//! `*_or_skip` helpers return `None` and the test prints a SKIP and passes, so the
//! suite still runs in environments without the infra.

#![allow(dead_code)]

use quotaenforcer::settings::Settings;
use quotaenforcer::store::RedisStore;
use redis::aio::MultiplexedConnection;
use redis::AsyncCommands;

pub fn settings() -> Settings {
    Settings::from_env().expect("settings from env")
}

/// A short unique token so concurrent/rerun tests never collide on keys or rows.
pub fn unique(tag: &str) -> String {
    format!("it-{tag}-{}-{:x}", std::process::id(), rand::random::<u32>())
}

pub async fn store_or_skip() -> Option<RedisStore> {
    match RedisStore::connect(&settings().redis_url).await {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("SKIP: redis unavailable: {e}");
            None
        }
    }
}

pub async fn redis_conn() -> MultiplexedConnection {
    redis::Client::open(settings().redis_url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

/// Raw `TTL` for asserting the TTL-set-once / preserved-on-refund invariants.
pub async fn ttl(conn: &mut MultiplexedConnection, key: &str) -> i64 {
    redis::cmd("TTL").arg(key).query_async(conn).await.unwrap()
}

pub async fn get_int(conn: &mut MultiplexedConnection, key: &str) -> Option<i64> {
    redis::cmd("GET").arg(key).query_async(conn).await.unwrap()
}

pub async fn del(conn: &mut MultiplexedConnection, key: &str) {
    let _: i64 = conn.del(key).await.unwrap();
}

/// Delete every counter key for a (unique) service — cleanup after service tests.
pub async fn del_service_keys(conn: &mut MultiplexedConnection, svc: &str) {
    let pattern = format!("rl:{{{svc}|*");
    let keys: Vec<String> = conn.keys(pattern).await.unwrap();
    for k in keys {
        del(conn, &k).await;
    }
}

// ---- Postgres (config source) ----

pub async fn pg_client_or_skip() -> Option<tokio_postgres::Client> {
    let s = settings();
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&s.pg_host)
        .port(s.pg_port)
        .user(&s.pg_user)
        .password(&s.pg_password)
        .dbname(&s.pg_database);
    match cfg.connect(tokio_postgres::NoTls).await {
        Ok((client, conn)) => {
            tokio::spawn(async move {
                let _ = conn.await;
            });
            // The audit trigger requires app.actor; set it for the whole session.
            client
                .batch_execute("SET app.actor = 'integration-test'")
                .await
                .unwrap();
            Some(client)
        }
        Err(e) => {
            eprintln!("SKIP: postgres unavailable: {e}");
            None
        }
    }
}

/// Upsert a `limit_config` row (creating the parent `service` row as needed).
pub async fn upsert_limit(
    client: &tokio_postgres::Client,
    svc: &str,
    cust: &str,
    rlid: &str,
    value: i64,
    unit: &str,
) {
    client
        .execute(
            "INSERT INTO service(service_name, display_name, owner) \
             VALUES ($1, $1, 'test') ON CONFLICT (service_name) DO NOTHING",
            &[&svc],
        )
        .await
        .unwrap();
    client
        .execute(
            "INSERT INTO limit_config(service_name, customer_id, rate_limit_id, limit_value, time_unit) \
             VALUES ($1, $2, $3, $4, $5::text::time_unit) \
             ON CONFLICT (service_name, customer_id, rate_limit_id) \
             DO UPDATE SET limit_value = EXCLUDED.limit_value, time_unit = EXCLUDED.time_unit",
            &[&svc, &cust, &rlid, &value, &unit],
        )
        .await
        .unwrap();
}

pub async fn cleanup_service(client: &tokio_postgres::Client, svc: &str) {
    client
        .execute("DELETE FROM limit_config WHERE service_name = $1", &[&svc])
        .await
        .unwrap();
    client
        .execute("DELETE FROM service WHERE service_name = $1", &[&svc])
        .await
        .unwrap();
}
