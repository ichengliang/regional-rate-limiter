//! `quotaenforcer` data-plane server entrypoint.
//!
//! Wires the config cache (Postgres) and Redis counter store into the gRPC
//! `RateLimiter` service and serves it. See `design/quotaenforcer.md`.

use std::sync::Arc;

use quotaenforcer::config::ConfigCache;
use quotaenforcer::pb::rate_limiter_server::RateLimiterServer;
use quotaenforcer::service::RateLimiterService;
use quotaenforcer::settings::Settings;
use quotaenforcer::store::RedisStore;
use tonic::transport::Server;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quotaenforcer=info,warn".into()),
        )
        .init();

    let settings = Settings::from_env()?;

    let store = RedisStore::connect(&settings.redis_url).await?;
    info!(redis = %settings.redis_url, "connected to counter store");

    let config = Arc::new(ConfigCache::connect(&settings)?);
    info!(host = %settings.pg_host, db = %settings.pg_database, "config cache pool ready");

    let svc = RateLimiterService::new(store, config, &settings);

    // gRPC server reflection so grpcurl et al. can call methods without local
    // .proto files.
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(quotaenforcer::FILE_DESCRIPTOR_SET)
        .build_v1()?;

    info!(addr = %settings.listen_addr, "quotaenforcer listening");
    Server::builder()
        .add_service(reflection)
        .add_service(RateLimiterServer::new(svc))
        .serve_with_shutdown(settings.listen_addr, async {
            let _ = tokio::signal::ctrl_c().await;
            info!("shutdown signal received");
        })
        .await?;
    Ok(())
}
