package com.anthropic.quotamgmt.auth;

import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;

/**
 * Extracts the caller identity from the {@code authorization: Bearer <token>}
 * metadata, authenticates it (design/quotamgmt.md §7.1), and pins the resulting
 * {@link Principal} into the gRPC {@link Context} for the duration of the call.
 * The service layer reads it via {@link #PRINCIPAL} and threads
 * {@code principal.name()} into {@code app.actor} (§7.3).
 *
 * <p>No RPC is anonymous: a missing/invalid token is closed with
 * {@code UNAUTHENTICATED} before the handler runs.
 */
public final class AuthInterceptor implements ServerInterceptor {

    public static final Context.Key<Principal> PRINCIPAL = Context.key("quotamgmt.principal");

    static final Metadata.Key<String> AUTHORIZATION =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
    private static final String BEARER_PREFIX = "Bearer ";

    private final Authorizer authorizer;

    public AuthInterceptor(Authorizer authorizer) {
        this.authorizer = authorizer;
    }

    /** Read the authenticated principal for the current call. */
    public static Principal currentPrincipal() {
        Principal principal = PRINCIPAL.get();
        if (principal == null) {
            // Should be unreachable: the interceptor rejects unauthenticated calls.
            throw AppException.of(Status.Code.UNAUTHENTICATED, "no authenticated principal");
        }
        return principal;
    }

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        Principal principal;
        try {
            principal = authorizer.authenticate(bearerToken(headers));
        } catch (AppException e) {
            call.close(Status.fromCode(e.code()).withDescription(e.getMessage()), new Metadata());
            return new ServerCall.Listener<>() {
            };
        }
        Context ctx = Context.current().withValue(PRINCIPAL, principal);
        return Contexts.interceptCall(ctx, call, headers, next);
    }

    private static String bearerToken(Metadata headers) {
        String raw = headers.get(AUTHORIZATION);
        if (raw == null) {
            return null;
        }
        if (raw.startsWith(BEARER_PREFIX)) {
            return raw.substring(BEARER_PREFIX.length()).trim();
        }
        return raw.trim();
    }
}
