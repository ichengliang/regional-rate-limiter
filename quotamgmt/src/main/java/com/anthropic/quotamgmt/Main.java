package com.anthropic.quotamgmt;

import io.grpc.Server;
import io.grpc.ServerBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Scaffold entrypoint for the quotamgmt control plane. Starts a plaintext gRPC
 * server and registers {@link LimitAdminService}. No business logic yet — see
 * design/quotamgmt.md.
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);
    private static final int DEFAULT_PORT = 8443;

    public static void main(String[] args) throws Exception {
        int port = Integer.getInteger("quotamgmt.port", DEFAULT_PORT);

        Server server = ServerBuilder.forPort(port)
                .addService(new LimitAdminService())
                .build()
                .start();

        log.info("quotamgmt listening on port {} (plaintext scaffold)", port);
        Runtime.getRuntime().addShutdownHook(new Thread(server::shutdown));
        server.awaitTermination();
    }
}
