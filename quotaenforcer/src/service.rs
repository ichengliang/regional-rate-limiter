//! The gRPC `RateLimiter` implementation (design §3).
//!
//! Every op shares one spine (design §3): **resolve cap → compute `window_id` →
//! run the single-key store op → map to response**. Unconfigured resolves to
//! *allow / unlimited* (design §5.3). The deadline and the final fail-open
//! synthesis live in the Client SDK (design §3.4); this tier surfaces store
//! failures as `UNAVAILABLE` for the SDK to fail open on.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tonic::{Request, Response, Status};

use crate::config::{ConfigCache, Resolved};
use crate::error::EnforcerError;
use crate::pb::common::LimitKey;
use crate::pb::rate_limiter_server::RateLimiter;
use crate::pb::{
    CheckQuotaBatchRequest, CheckQuotaBatchResponse, CheckQuotaRequest, CheckQuotaResponse,
    ChargeRequest, ChargeResponse, GetUsageRequest, GetUsageResponse, RefundRequest, RefundResponse,
};
use crate::settings::Settings;
use crate::store::{counter_key, RedisStore};
use crate::window::{compute_window, jitter_cap_secs, jittered_ttl};

pub struct RateLimiterService {
    store: RedisStore,
    config: Arc<ConfigCache>,
    ttl_grace_secs: i64,
    max_batch_size: usize,
}

impl RateLimiterService {
    pub fn new(store: RedisStore, config: Arc<ConfigCache>, settings: &Settings) -> Self {
        Self {
            store,
            config,
            ttl_grace_secs: settings.ttl_grace_secs,
            max_batch_size: settings.max_batch_size,
        }
    }

    // ---- one-key operations (reused by the single and batch RPCs) ----

    async fn check_one(&self, req: &CheckQuotaRequest) -> Result<CheckQuotaResponse, EnforcerError> {
        let key = validate_key(&req.key)?;
        let cost = normalize_cost(req.cost)?;

        let cap = match self.config.resolve(&key.service_name, &key.customer_id, &key.rate_limit_id).await {
            Resolved::Unconfigured => return Ok(allow_check()),
            Resolved::Configured(cap) => cap,
        };
        let Some(window) = compute_window(Utc::now(), cap.time_unit) else {
            return Ok(allow_check());
        };
        let rkey = counter_key(&key.service_name, &key.customer_id, &key.rate_limit_id, &window.window_id);
        let res = self.store.check(&rkey, cap.limit_value, cost).await?;
        Ok(CheckQuotaResponse {
            allowed: res.allowed,
            remaining: res.remaining,
            limit: cap.limit_value,
            reset_at: Some(to_timestamp(window.reset_at)),
        })
    }

    async fn charge_one(&self, req: &ChargeRequest) -> Result<ChargeResponse, EnforcerError> {
        let key = validate_key(&req.key)?;
        let cost = normalize_cost(req.cost)?;

        let cap = match self.config.resolve(&key.service_name, &key.customer_id, &key.rate_limit_id).await {
            Resolved::Unconfigured => return Ok(unlimited_charge()),
            Resolved::Configured(cap) => cap,
        };
        let Some(window) = compute_window(Utc::now(), cap.time_unit) else {
            return Ok(unlimited_charge());
        };
        let ttl = jittered_ttl(window.remaining_secs, self.ttl_grace_secs, jitter_cap_secs(cap.time_unit));
        let rkey = counter_key(&key.service_name, &key.customer_id, &key.rate_limit_id, &window.window_id);
        let remaining = self.store.charge(&rkey, cost, cap.limit_value, ttl).await?;
        Ok(ChargeResponse {
            remaining,
            limit: cap.limit_value,
            reset_at: Some(to_timestamp(window.reset_at)),
        })
    }

    async fn refund_one(&self, req: &RefundRequest) -> Result<RefundResponse, EnforcerError> {
        let key = validate_key(&req.key)?;
        let amount = validate_amount(req.amount)?;

        let cap = match self.config.resolve(&key.service_name, &key.customer_id, &key.rate_limit_id).await {
            Resolved::Unconfigured => return Ok(unlimited_refund()),
            Resolved::Configured(cap) => cap,
        };
        let Some(window) = compute_window(Utc::now(), cap.time_unit) else {
            return Ok(unlimited_refund());
        };
        let rkey = counter_key(&key.service_name, &key.customer_id, &key.rate_limit_id, &window.window_id);
        let remaining = self.store.refund(&rkey, amount, cap.limit_value).await?;
        Ok(RefundResponse {
            remaining,
            limit: cap.limit_value,
            reset_at: Some(to_timestamp(window.reset_at)),
        })
    }
}

#[tonic::async_trait]
impl RateLimiter for RateLimiterService {
    async fn check_quota(
        &self,
        req: Request<CheckQuotaRequest>,
    ) -> Result<Response<CheckQuotaResponse>, Status> {
        Ok(Response::new(self.check_one(req.get_ref()).await?))
    }

    async fn check_quota_batch(
        &self,
        req: Request<CheckQuotaBatchRequest>,
    ) -> Result<Response<CheckQuotaBatchResponse>, Status> {
        let batch = req.into_inner();
        if batch.requests.len() > self.max_batch_size {
            return Err(EnforcerError::InvalidArgument(format!(
                "batch size {} exceeds max {}",
                batch.requests.len(),
                self.max_batch_size
            ))
            .into());
        }
        // Each result mirrors the full single-key response, incl. its own reset_at
        // (design §3.5): batched keys can have different windows.
        let mut results = Vec::with_capacity(batch.requests.len());
        for r in &batch.requests {
            results.push(self.check_one(r).await?);
        }
        Ok(Response::new(CheckQuotaBatchResponse { results }))
    }

    async fn charge(
        &self,
        req: Request<ChargeRequest>,
    ) -> Result<Response<ChargeResponse>, Status> {
        Ok(Response::new(self.charge_one(req.get_ref()).await?))
    }

    async fn refund(
        &self,
        req: Request<RefundRequest>,
    ) -> Result<Response<RefundResponse>, Status> {
        Ok(Response::new(self.refund_one(req.get_ref()).await?))
    }

    async fn get_usage(
        &self,
        req: Request<GetUsageRequest>,
    ) -> Result<Response<GetUsageResponse>, Status> {
        let req = req.into_inner();
        let key = validate_key(&req.key)?;

        let cap = match self.config.resolve(&key.service_name, &key.customer_id, &key.rate_limit_id).await {
            Resolved::Unconfigured => {
                return Ok(Response::new(GetUsageResponse {
                    consumed: 0,
                    remaining: 0,
                    limit: 0,
                    reset_at: None,
                    configured: false,
                }));
            }
            Resolved::Configured(cap) => cap,
        };
        let window = compute_window(Utc::now(), cap.time_unit)
            .ok_or_else(|| Status::internal("configured limit has unspecified time unit"))?;
        let rkey = counter_key(&key.service_name, &key.customer_id, &key.rate_limit_id, &window.window_id);
        let consumed = self
            .store
            .consumed(&rkey)
            .await
            .map_err(EnforcerError::from)?;
        Ok(Response::new(GetUsageResponse {
            consumed,
            remaining: cap.limit_value - consumed,
            limit: cap.limit_value,
            reset_at: Some(to_timestamp(window.reset_at)),
            configured: true,
        }))
    }
}

// ---- helpers ----

/// Validate the key: all three tuple fields must be non-empty (design §2.2).
fn validate_key(key: &Option<LimitKey>) -> Result<&LimitKey, EnforcerError> {
    let key = key
        .as_ref()
        .ok_or_else(|| EnforcerError::InvalidArgument("key is required".into()))?;
    if key.service_name.is_empty() || key.customer_id.is_empty() || key.rate_limit_id.is_empty() {
        return Err(EnforcerError::InvalidArgument(
            "key.service_name, key.customer_id, key.rate_limit_id must all be set".into(),
        ));
    }
    Ok(key)
}

/// `cost` defaults to 1 when 0/unset (proto); negative is invalid.
fn normalize_cost(cost: i64) -> Result<i64, EnforcerError> {
    match cost {
        0 => Ok(1),
        c if c < 0 => Err(EnforcerError::InvalidArgument("cost must be >= 0".into())),
        c => Ok(c),
    }
}

/// `amount` must be non-negative; 0 is a no-op refund (no default-to-1).
fn validate_amount(amount: i64) -> Result<i64, EnforcerError> {
    if amount < 0 {
        return Err(EnforcerError::InvalidArgument("amount must be >= 0".into()));
    }
    Ok(amount)
}

/// Unconfigured check → allow / unlimited (design §5.3). `limit`/`remaining` are 0
/// sentinels; `allowed` is what the caller acts on.
fn allow_check() -> CheckQuotaResponse {
    CheckQuotaResponse {
        allowed: true,
        remaining: 0,
        limit: 0,
        reset_at: None,
    }
}

fn unlimited_charge() -> ChargeResponse {
    ChargeResponse {
        remaining: 0,
        limit: 0,
        reset_at: None,
    }
}

fn unlimited_refund() -> RefundResponse {
    RefundResponse {
        remaining: 0,
        limit: 0,
        reset_at: None,
    }
}

fn to_timestamp(dt: DateTime<Utc>) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: dt.timestamp(),
        nanos: dt.timestamp_subsec_nanos() as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_defaults_to_one() {
        assert_eq!(normalize_cost(0).unwrap(), 1);
        assert_eq!(normalize_cost(5).unwrap(), 5);
        assert!(normalize_cost(-1).is_err());
    }

    #[test]
    fn amount_must_be_non_negative() {
        assert_eq!(validate_amount(0).unwrap(), 0);
        assert_eq!(validate_amount(3).unwrap(), 3);
        assert!(validate_amount(-1).is_err());
    }

    #[test]
    fn key_validation() {
        assert!(validate_key(&None).is_err());
        assert!(validate_key(&Some(LimitKey {
            service_name: "s".into(),
            customer_id: "".into(),
            rate_limit_id: "r".into(),
        }))
        .is_err());
        assert!(validate_key(&Some(LimitKey {
            service_name: "s".into(),
            customer_id: "c".into(),
            rate_limit_id: "r".into(),
        }))
        .is_ok());
    }
}
