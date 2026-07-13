package com.anthropic.quotamgmt.auth;

import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Status;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A simple token-to-{@link Principal} registry standing in for the platform
 * identity system (design/quotamgmt.md §7.2: "grants live in the platform's
 * identity system … quotamgmt consumes them"). Real deployments swap this for an
 * SSO/mTLS-backed {@link Authorizer}; this keeps the wiring identical and the
 * grant logic testable.
 */
public final class InMemoryAuthorizer implements Authorizer {

    private final Map<String, Principal> byToken = new ConcurrentHashMap<>();

    /** Register (or replace) the principal a bearer token authenticates to. */
    public InMemoryAuthorizer put(String token, Principal principal) {
        byToken.put(token, principal);
        return this;
    }

    @Override
    public Principal authenticate(String bearerToken) {
        if (bearerToken == null || bearerToken.isEmpty()) {
            throw AppException.of(Status.Code.UNAUTHENTICATED, "missing bearer token");
        }
        Principal principal = byToken.get(bearerToken);
        if (principal == null) {
            throw AppException.of(Status.Code.UNAUTHENTICATED, "unknown or expired token");
        }
        return principal;
    }
}
