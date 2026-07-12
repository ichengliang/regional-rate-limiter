//! `quotaenforcer` data-plane server (scaffold).
//!
//! Stub tonic server implementing `quotaenforcer.v1.RateLimiter`. Every method
//! currently returns `unimplemented`. The hot-path logic (Redis Lua ops, config
//! cache, fail-open, sharding, window math) is specified in
//! `design/quotaenforcer.md` and is NOT implemented here.

use std::net::SocketAddr;

use tonic::{transport::Server, Request, Response, Status};

// Generated code, nested to mirror the proto package paths so the cross-package
// references (`quotaenforcer.v1` -> `quota.common.v1`) resolve.
mod quotaenforcer {
    pub mod v1 {
        tonic::include_proto!("quotaenforcer.v1");
    }
}
mod quota {
    pub mod common {
        pub mod v1 {
            tonic::include_proto!("quota.common.v1");
        }
    }
}

use quotaenforcer::v1 as pb;
use pb::rate_limiter_server::{RateLimiter, RateLimiterServer};
use pb::{
    CheckQuotaBatchRequest, CheckQuotaBatchResponse, CheckQuotaRequest, CheckQuotaResponse,
    ChargeRequest, ChargeResponse, GetUsageRequest, GetUsageResponse, RefundRequest, RefundResponse,
};

#[derive(Default)]
struct RateLimiterService;

#[tonic::async_trait]
impl RateLimiter for RateLimiterService {
    // TODO: implement per design/quotaenforcer.md §3 (request flows) and §4 (Redis).
    async fn check_quota(
        &self,
        _req: Request<CheckQuotaRequest>,
    ) -> Result<Response<CheckQuotaResponse>, Status> {
        Err(Status::unimplemented("CheckQuota: see design/quotaenforcer.md §3.1"))
    }

    async fn check_quota_batch(
        &self,
        _req: Request<CheckQuotaBatchRequest>,
    ) -> Result<Response<CheckQuotaBatchResponse>, Status> {
        Err(Status::unimplemented("CheckQuotaBatch: see design/quotaenforcer.md §6.4"))
    }

    async fn charge(
        &self,
        _req: Request<ChargeRequest>,
    ) -> Result<Response<ChargeResponse>, Status> {
        Err(Status::unimplemented("Charge: see design/quotaenforcer.md §3.2"))
    }

    async fn refund(
        &self,
        _req: Request<RefundRequest>,
    ) -> Result<Response<RefundResponse>, Status> {
        Err(Status::unimplemented("Refund: see design/quotaenforcer.md §3.3"))
    }

    async fn get_usage(
        &self,
        _req: Request<GetUsageRequest>,
    ) -> Result<Response<GetUsageResponse>, Status> {
        Err(Status::unimplemented("GetUsage: see design/quotaenforcer.md §2.2"))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = std::env::var("QUOTAENFORCER_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8444".to_string())
        .parse()?;

    println!("quotaenforcer listening on {addr}");
    Server::builder()
        .add_service(RateLimiterServer::new(RateLimiterService))
        .serve(addr)
        .await?;
    Ok(())
}
