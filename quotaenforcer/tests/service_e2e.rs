//! End-to-end tests of the gRPC `RateLimiter` service against real local Redis +
//! Postgres. Drives the full spine (config resolve → window → store op → response)
//! and the fail-open-on-unconfigured path (design §3, §5).

mod common;

use std::sync::Arc;

use common::*;
use quotaenforcer::config::ConfigCache;
use quotaenforcer::pb::common::LimitKey;
use quotaenforcer::pb::rate_limiter_server::RateLimiter;
use quotaenforcer::pb::{
    CheckQuotaRequest, ChargeRequest, GetUsageRequest, RefundRequest,
};
use quotaenforcer::service::RateLimiterService;
use quotaenforcer::store::RedisStore;
use tonic::Request;

async fn service() -> Option<(RateLimiterService, tokio_postgres::Client)> {
    let store = RedisStore::connect(&settings().redis_url).await.ok();
    let store = match store {
        Some(s) => s,
        None => {
            eprintln!("SKIP: redis unavailable");
            return None;
        }
    };
    let pg = pg_client_or_skip().await?;
    let config = Arc::new(ConfigCache::connect(&settings()).unwrap());
    let svc = RateLimiterService::new(store, config, &settings());
    Some((svc, pg))
}

fn key(svc: &str, cust: &str, rlid: &str) -> Option<LimitKey> {
    Some(LimitKey {
        service_name: svc.into(),
        customer_id: cust.into(),
        rate_limit_id: rlid.into(),
    })
}

#[tokio::test]
async fn check_charge_refund_get_usage_happy_path() {
    let Some((svc, pg)) = service().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let service_name = unique("svc");
    let cust = "cust_42";
    let rlid = "requests_per_min";
    upsert_limit(&pg, &service_name, cust, rlid, 1000, "MINUTE").await;

    // Fresh window: full quota.
    let c = svc
        .check_quota(Request::new(CheckQuotaRequest {
            key: key(&service_name, cust, rlid),
            cost: 1,
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(c.allowed);
    assert_eq!(c.remaining, 1000);
    assert_eq!(c.limit, 1000);
    assert!(c.reset_at.is_some());

    // Charge cost 3 → remaining 997.
    let ch = svc
        .charge(Request::new(ChargeRequest {
            key: key(&service_name, cust, rlid),
            cost: 3,
            request_id: "req_a1b2c3".into(),
        }))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(ch.remaining, 997);
    assert_eq!(ch.limit, 1000);

    // Refund 3 → back to 1000.
    let rf = svc
        .refund(Request::new(RefundRequest {
            key: key(&service_name, cust, rlid),
            amount: 3,
            request_id: "req_a1b2c3".into(),
        }))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(rf.remaining, 1000);

    // Charge 1 then GetUsage reflects consumed=1.
    svc.charge(Request::new(ChargeRequest {
        key: key(&service_name, cust, rlid),
        cost: 1,
        request_id: String::new(),
    }))
    .await
    .unwrap();
    let u = svc
        .get_usage(Request::new(GetUsageRequest {
            key: key(&service_name, cust, rlid),
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(u.configured);
    assert_eq!(u.consumed, 1);
    assert_eq!(u.remaining, 999);
    assert_eq!(u.limit, 1000);

    del_service_keys(&mut conn, &service_name).await;
    cleanup_service(&pg, &service_name).await;
}

#[tokio::test]
async fn star_default_applies_to_unlisted_customer() {
    let Some((svc, pg)) = service().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let service_name = unique("svc");
    let rlid = "tokens_per_min";
    // Only a '*' default row exists.
    upsert_limit(&pg, &service_name, "*", rlid, 50, "MINUTE").await;

    let c = svc
        .check_quota(Request::new(CheckQuotaRequest {
            key: key(&service_name, "some_unlisted_customer", rlid),
            cost: 1,
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(c.allowed);
    assert_eq!(c.limit, 50, "unlisted customer rides the '*' default");

    del_service_keys(&mut conn, &service_name).await;
    cleanup_service(&pg, &service_name).await;
}

#[tokio::test]
async fn exact_customer_row_wins_over_default() {
    let Some((svc, pg)) = service().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let service_name = unique("svc");
    let rlid = "tokens_per_min";
    upsert_limit(&pg, &service_name, "*", rlid, 50, "MINUTE").await;
    upsert_limit(&pg, &service_name, "vip", rlid, 9000, "MINUTE").await;

    let c = svc
        .check_quota(Request::new(CheckQuotaRequest {
            key: key(&service_name, "vip", rlid),
            cost: 1,
        }))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(c.limit, 9000, "exact row wins over '*'");

    del_service_keys(&mut conn, &service_name).await;
    cleanup_service(&pg, &service_name).await;
}

#[tokio::test]
async fn unconfigured_limit_allows_unlimited() {
    let Some((svc, _pg)) = service().await else {
        return;
    };
    // Never configured: no exact row, no '*'.
    let service_name = unique("svc");

    let c = svc
        .check_quota(Request::new(CheckQuotaRequest {
            key: key(&service_name, "anyone", "never_configured"),
            cost: 1,
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(c.allowed, "unconfigured => allow (unlimited)");
    assert_eq!(c.limit, 0);

    let u = svc
        .get_usage(Request::new(GetUsageRequest {
            key: key(&service_name, "anyone", "never_configured"),
        }))
        .await
        .unwrap()
        .into_inner();
    assert!(!u.configured);
}

#[tokio::test]
async fn invalid_key_is_rejected() {
    let Some((svc, _pg)) = service().await else {
        return;
    };
    // Missing key entirely.
    let err = svc
        .check_quota(Request::new(CheckQuotaRequest { key: None, cost: 1 }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::InvalidArgument);

    // Negative cost.
    let err = svc
        .check_quota(Request::new(CheckQuotaRequest {
            key: key("s", "c", "r"),
            cost: -5,
        }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::InvalidArgument);
}
