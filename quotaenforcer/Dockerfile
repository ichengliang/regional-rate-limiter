# quotaenforcer (data plane, Rust / gRPC).
# Build context is the REPOSITORY ROOT (build.rs compiles ../proto), so build with:
#   docker build -f quotaenforcer/Dockerfile -t quotaenforcer .
FROM rust:1-bookworm AS build
# protoc is required by tonic-build (see build.rs). libprotobuf-dev ships the
# well-known .proto files (google/protobuf/timestamp.proto, etc.) that our
# contracts import — protobuf-compiler alone does NOT include them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY proto/ proto/
COPY quotaenforcer/ quotaenforcer/
WORKDIR /src/quotaenforcer
RUN cargo build --release --bin quotaenforcer

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/quotaenforcer/target/release/quotaenforcer /app/quotaenforcer
# Listen on all interfaces so the Service/LB can reach the pod.
ENV QUOTAENFORCER_ADDR=0.0.0.0:8444
EXPOSE 8444
ENTRYPOINT ["/app/quotaenforcer"]
