package com.anthropic.quotamgmt;

import com.anthropic.quotamgmt.auth.AuthInterceptor;
import com.anthropic.quotamgmt.auth.InMemoryAuthorizer;
import com.anthropic.quotamgmt.auth.Principal;
import com.anthropic.quotamgmt.config.AppConfig;
import com.anthropic.quotamgmt.db.DataSourceProvider;
import com.anthropic.quotamgmt.store.AuditRepository;
import com.anthropic.quotamgmt.store.LimitRepository;
import com.anthropic.quotamgmt.store.ServiceRepository;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.zaxxer.hikari.HikariDataSource;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.ServerInterceptors;
import io.grpc.protobuf.services.ProtoReflectionServiceV1;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;

/**
 * Entrypoint for the quotamgmt control plane. Wires the Postgres-backed
 * repositories, the auth interceptor, and the {@link LimitAdminService} behind a
 * gRPC server (design/quotamgmt.md §9.1).
 *
 * <p>Auth bootstrap: a full deployment plugs an SSO/mTLS-backed
 * {@link com.anthropic.quotamgmt.auth.Authorizer} (§7.1). For local use, a single
 * dev platform-admin token can be seeded with
 * {@code -Dquotamgmt.auth.devAdminToken=...} (name via
 * {@code -Dquotamgmt.auth.devAdminName}); without it, all calls are
 * {@code UNAUTHENTICATED}.
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);

    public static void main(String[] args) throws Exception {
        AppConfig config = AppConfig.fromEnvironment();
        HikariDataSource dataSource = DataSourceProvider.create(config);

        LimitRepository limits = new LimitRepository(dataSource);
        ServiceRepository services = new ServiceRepository(dataSource);
        AuditRepository audit = new AuditRepository(dataSource);
        InMemoryAuthorizer authorizer = seedAuthorizer();

        LimitAdminService service = new LimitAdminService(limits, services, audit, authorizer);
        Server server = ServerBuilder.forPort(config.grpcPort())
                .addService(ServerInterceptors.intercept(service, new AuthInterceptor(authorizer)))
                // Reflection is registered without the auth interceptor so API
                // discovery does not require a token (dev convenience).
                .addService(ProtoReflectionServiceV1.newInstance())
                .build()
                .start();

        log.info("quotamgmt listening on port {} (Postgres {})", config.grpcPort(), config.jdbcUrl());
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.shutdown();
            dataSource.close();
        }));
        server.awaitTermination();
    }

    private static InMemoryAuthorizer seedAuthorizer() {
        InMemoryAuthorizer authorizer = new InMemoryAuthorizer();
        String devToken = System.getProperty("quotamgmt.auth.devAdminToken");
        if (devToken != null && !devToken.isEmpty()) {
            String name = System.getProperty("quotamgmt.auth.devAdminName", "dev-admin");
            authorizer.put(devToken, new Principal(name, Set.of(), Set.of(), true));
            log.warn("Seeded dev platform-admin principal '{}' from -Dquotamgmt.auth.devAdminToken", name);
        }
        String file = System.getProperty("quotamgmt.auth.file");
        if (file != null && !file.isEmpty()) {
            loadPrincipalsFile(authorizer, Path.of(file));
        }
        return authorizer;
    }

    /**
     * Load a JSON array of dev principals into the authorizer. Each element:
     * {@code {"token": "...", "name": "...", "platformAdmin": false,
     * "editor": ["svc"], "viewer": ["svc"]}}. Dev/local only — real deployments
     * plug an SSO/mTLS-backed Authorizer (§7.1).
     */
    private static void loadPrincipalsFile(InMemoryAuthorizer authorizer, Path path) {
        try {
            JsonArray arr = JsonParser.parseString(Files.readString(path)).getAsJsonArray();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                String token = o.get("token").getAsString();
                String name = o.get("name").getAsString();
                boolean admin = o.has("platformAdmin") && o.get("platformAdmin").getAsBoolean();
                authorizer.put(token, new Principal(name, names(o, "editor"), names(o, "viewer"), admin));
            }
            log.warn("Seeded {} dev principal(s) from {}", arr.size(), path);
        } catch (Exception e) {
            throw new IllegalStateException("failed to load auth principals file: " + path, e);
        }
    }

    private static Set<String> names(JsonObject o, String field) {
        Set<String> out = new HashSet<>();
        if (o.has(field)) {
            o.get(field).getAsJsonArray().forEach(e -> out.add(e.getAsString()));
        }
        return out;
    }
}
