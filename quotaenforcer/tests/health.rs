//! Verifies the gRPC health service (`grpc.health.v1.Health`) reports SERVING —
//! this is exactly what the Kubernetes `grpc` readiness/liveness probes call.
//!
//! No Redis/Postgres needed: the health wiring is independent of the data-plane
//! backends (`set_serving::<T>()` only reads T's service name), so this always
//! runs. It mirrors the wiring in `main.rs`.

use quotaenforcer::pb::rate_limiter_server::RateLimiterServer;
use quotaenforcer::service::RateLimiterService;
use tonic::transport::server::TcpIncoming;
use tonic::transport::{Channel, Server};
use tonic_health::pb::health_check_response::ServingStatus as PbServing;
use tonic_health::pb::health_client::HealthClient;
use tonic_health::pb::HealthCheckRequest;

#[tokio::test]
async fn health_reports_serving_for_overall_and_named_service() {
    // Wire the health reporter exactly as main.rs does.
    let (mut reporter, health_service) = tonic_health::server::health_reporter();
    reporter
        .set_serving::<RateLimiterServer<RateLimiterService>>()
        .await;
    reporter
        .set_service_status("", tonic_health::ServingStatus::Serving)
        .await;

    // Serve on an ephemeral loopback port.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let incoming = TcpIncoming::from_listener(listener, true, None).unwrap();
    tokio::spawn(async move {
        Server::builder()
            .add_service(health_service)
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });

    let channel = Channel::from_shared(format!("http://{addr}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let mut client = HealthClient::new(channel);

    // The empty overall service (what a default k8s grpc probe queries) and the
    // named RateLimiter service both report SERVING.
    for service in ["", "quotaenforcer.v1.RateLimiter"] {
        let status = client
            .check(HealthCheckRequest {
                service: service.into(),
            })
            .await
            .unwrap()
            .into_inner()
            .status;
        assert_eq!(
            status,
            PbServing::Serving as i32,
            "service '{service}' should be SERVING"
        );
    }
}
