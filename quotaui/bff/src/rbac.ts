// RBAC — the authoritative authorization layer (design §1.4, §4.3).
//
// Enforced in the BFF (this module) as the source of truth; the SPA mirrors it
// only for UX (hide/disable) and is NEVER trusted. Every mutating route calls
// `authorize()` before touching quotamgmt/quotaenforcer.

export type Role = "viewer" | "service-editor" | "operator" | "admin";

// A grant binds a role to a scope. `service` is required for `service-editor`
// (per-service scope) and ignored for the global roles (viewer/operator/admin).
export interface Grant {
  role: Role;
  service?: string;
}

export interface User {
  id: string; // stable subject (e.g. OIDC sub)
  email: string; // used as the audit `changed_by` actor (design §4.4)
  grants: Grant[];
}

// Capabilities map 1:1 to the permissions matrix rows in design §1.4.
export type Capability =
  | "limits:read"
  | "usage:read"
  | "audit:read"
  | "observability:read"
  | "limit:write"
  | "limit:delete"
  | "service:create"
  | "service:edit"
  | "op:refund"
  | "op:reset"
  | "review:approve"
  | "rbac:manage";

export interface Policy {
  // ¹ design §1.4: creating a brand-new service_name may be gated to operator/
  // admin to prevent namespace grabs. Default: gated (false = editors can't).
  allowServiceEditorCreateService: boolean;
}

export const DEFAULT_POLICY: Policy = {
  allowServiceEditorCreateService: false,
};

// Does the user hold a global (unscoped) role at least as strong as `role`?
function hasGlobalRole(user: User, role: Role): boolean {
  const rank: Record<Role, number> = {
    viewer: 0,
    "service-editor": 1,
    operator: 2,
    admin: 3,
  };
  return user.grants.some((g) => !g.service && rank[g.role] >= rank[role]);
}

function isGlobalOperatorOrAdmin(user: User): boolean {
  return hasGlobalRole(user, "operator");
}

// May the user edit config for a specific service? operator/admin globally, or a
// service-editor scoped to that exact service.
function canEditService(user: User, service: string): boolean {
  if (isGlobalOperatorOrAdmin(user)) return true;
  return user.grants.some((g) => g.role === "service-editor" && g.service === service);
}

// The set of services a user may edit (empty ⇒ only via a global role). Used by
// the SPA-facing session payload so the picker can be scoped.
export function editableServices(user: User): string[] {
  return Array.from(
    new Set(
      user.grants
        .filter((g) => g.role === "service-editor" && g.service)
        .map((g) => g.service as string),
    ),
  );
}

export interface AuthzResult {
  ok: boolean;
  reason?: string;
}

// The single decision function. `service` is required for anything service-scoped;
// omit it for global capabilities (audit read is treated as global-read here).
export function authorize(
  user: User,
  cap: Capability,
  service: string | undefined,
  policy: Policy = DEFAULT_POLICY,
): AuthzResult {
  const anyAuthenticated = user.grants.length > 0;

  switch (cap) {
    // Reads available to anyone with a grant (any role can view — design §1.4).
    case "limits:read":
    case "usage:read":
    case "audit:read":
    case "observability:read":
      return anyAuthenticated
        ? { ok: true }
        : { ok: false, reason: "no roles" };

    case "limit:write":
    case "limit:delete":
    case "service:edit":
      if (!service) return { ok: false, reason: "service required" };
      return canEditService(user, service)
        ? { ok: true }
        : { ok: false, reason: `not an editor of ${service}` };

    case "service:create":
      if (isGlobalOperatorOrAdmin(user)) return { ok: true };
      if (policy.allowServiceEditorCreateService && service && canEditService(user, service)) {
        return { ok: true };
      }
      return { ok: false, reason: "service creation is gated to operator/admin" };

    case "op:refund":
    case "op:reset":
    case "review:approve":
      return isGlobalOperatorOrAdmin(user)
        ? { ok: true }
        : { ok: false, reason: "requires operator/admin" };

    case "rbac:manage":
      return hasGlobalRole(user, "admin")
        ? { ok: true }
        : { ok: false, reason: "requires admin" };

    default:
      return { ok: false, reason: "unknown capability" };
  }
}
