//! Error mapping to gRPC `Status`.
//!
//! Store failures surface as `UNAVAILABLE` — the transport signal the Client SDK
//! turns into a fail-open allow (design §6.3, §10). Validation failures surface as
//! `INVALID_ARGUMENT`, which the SDK also treats as allow-and-log (never a 429).

use thiserror::Error;
use tonic::Status;

#[derive(Error, Debug)]
pub enum EnforcerError {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("counter store unavailable: {0}")]
    Store(#[from] redis::RedisError),
}

impl From<EnforcerError> for Status {
    fn from(e: EnforcerError) -> Self {
        match e {
            EnforcerError::InvalidArgument(m) => Status::invalid_argument(m),
            EnforcerError::Store(e) => Status::unavailable(format!("counter store: {e}")),
        }
    }
}
