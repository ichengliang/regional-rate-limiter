package com.anthropic.quotamgmt.auth;

import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Status;

/**
 * AuthN + AuthZ for the control plane (design/quotamgmt.md §7). Authentication
 * resolves a bearer token to a {@link Principal}; authorization checks that
 * principal's per-{@code service_name} grants (§7.2). Grants themselves live in
 * the platform identity system; this interface only consumes them, so alternate
 * backends (static config, an IdP lookup) can be dropped in.
 *
 * <p>Missing/invalid identity → {@code UNAUTHENTICATED}; authenticated but not
 * scoped → {@code PERMISSION_DENIED} (§3.10).
 */
public interface Authorizer {

    /** Resolve a bearer token to a principal, or throw {@code UNAUTHENTICATED}. */
    Principal authenticate(String bearerToken);

    default void requireEditor(Principal principal, String serviceName) {
        if (!principal.canEdit(serviceName)) {
            throw AppException.of(Status.Code.PERMISSION_DENIED,
                    "identity '" + principal.name() + "' is not an editor of service '"
                            + serviceName + "'");
        }
    }

    default void requireViewer(Principal principal, String serviceName) {
        if (!principal.canView(serviceName)) {
            throw AppException.of(Status.Code.PERMISSION_DENIED,
                    "identity '" + principal.name() + "' cannot view service '"
                            + serviceName + "'");
        }
    }

    default void requirePlatformAdmin(Principal principal) {
        if (!principal.platformAdmin()) {
            throw AppException.of(Status.Code.PERMISSION_DENIED,
                    "identity '" + principal.name() + "' is not a platform admin");
        }
    }
}
