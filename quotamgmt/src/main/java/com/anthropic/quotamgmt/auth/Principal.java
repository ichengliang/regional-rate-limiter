package com.anthropic.quotamgmt.auth;

import java.util.Set;

/**
 * An authenticated caller (design/quotamgmt.md §7.1) and its RBAC grants (§7.2).
 * The {@link #name()} is the value written to {@code app.actor} and thus to
 * {@code limit_config_audit.changed_by} — a human ({@code alice@corp}), a service
 * ({@code svc:search-svc-ci}), or an operator.
 *
 * <p>Grants are consumed from the platform identity system, not administered
 * here (§7.2): {@code editorServices}/{@code viewerServices} scope per
 * {@code service_name}; {@code platformAdmin} spans all services and may register
 * services.
 */
public final class Principal {

    private final String name;
    private final Set<String> editorServices;
    private final Set<String> viewerServices;
    private final boolean platformAdmin;

    public Principal(String name, Set<String> editorServices, Set<String> viewerServices,
                     boolean platformAdmin) {
        this.name = name;
        this.editorServices = Set.copyOf(editorServices);
        this.viewerServices = Set.copyOf(viewerServices);
        this.platformAdmin = platformAdmin;
    }

    public String name() {
        return name;
    }

    public boolean platformAdmin() {
        return platformAdmin;
    }

    /** May edit (CRUD) limits for {@code serviceName}? (§7.2 service-editor / platform-admin) */
    public boolean canEdit(String serviceName) {
        return platformAdmin || editorServices.contains(serviceName);
    }

    /** May read config/audit for {@code serviceName}? Editors imply viewers. (§7.2) */
    public boolean canView(String serviceName) {
        return platformAdmin || editorServices.contains(serviceName)
                || viewerServices.contains(serviceName);
    }

    /** Services this principal can view, for scoping ListServices (§7.2 tenant scope). */
    public Set<String> viewableServices() {
        java.util.Set<String> all = new java.util.HashSet<>(editorServices);
        all.addAll(viewerServices);
        return all;
    }
}
