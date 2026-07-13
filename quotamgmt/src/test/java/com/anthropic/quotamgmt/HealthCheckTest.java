package com.anthropic.quotamgmt;

import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse.ServingStatus;
import io.grpc.health.v1.HealthGrpc;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.protobuf.services.HealthStatusManager;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The gRPC health service (grpc.health.v1.Health) backing the Kubernetes {@code
 * grpc} probe reports SERVING. Needs no Postgres — the health wiring is
 * independent of the DB — so it runs in the plain unit suite. Mirrors the
 * registration in {@link Main}.
 */
class HealthCheckTest {

    private Server server;
    private ManagedChannel channel;

    @BeforeEach
    void setUp() throws Exception {
        String name = InProcessServerBuilder.generateName();
        HealthStatusManager health = new HealthStatusManager();
        health.setStatus("", ServingStatus.SERVING);
        server = InProcessServerBuilder.forName(name)
                .directExecutor()
                .addService(health.getHealthService())
                .build()
                .start();
        channel = InProcessChannelBuilder.forName(name).directExecutor().build();
    }

    @AfterEach
    void tearDown() {
        channel.shutdownNow();
        server.shutdownNow();
    }

    @Test
    void overallHealthIsServing() {
        ServingStatus status = HealthGrpc.newBlockingStub(channel)
                .check(HealthCheckRequest.newBuilder().setService("").build())
                .getStatus();
        assertEquals(ServingStatus.SERVING, status);
    }
}
