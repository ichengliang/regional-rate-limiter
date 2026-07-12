// Frontend RBAC mirror — UX ONLY (design §4.3). Used to hide/disable actions the
// user can't perform. This is NEVER trusted for security: the BFF re-checks every
// request authoritatively. Keep the decision semantics in sync with bff/src/rbac.ts.

export type Role = "viewer" | "service-editor" | "operator" | "admin";

export interface Grant {
  role: Role;
  service?: string;
}

export type Capability =
  | "limits:read"
  | "usage:read"
  | "audit:read"
  | "limit:write"
  | "limit:delete"
  | "service:create"
  | "service:edit"
  | "op:refund"
  | "op:reset"
  | "review:approve"
  | "rbac:manage";

const RANK: Record<Role, number> = { viewer: 0, "service-editor": 1, operator: 2, admin: 3 };

function hasGlobalRole(grants: Grant[], role: Role): boolean {
  return grants.some((g) => !g.service && RANK[g.role] >= RANK[role]);
}

function isOperatorOrAdmin(grants: Grant[]): boolean {
  return hasGlobalRole(grants, "operator");
}

function canEditService(grants: Grant[], service: string | undefined): boolean {
  if (isOperatorOrAdmin(grants)) return true;
  if (!service) return false;
  return grants.some((g) => g.role === "service-editor" && g.service === service);
}

export function canDo(
  grants: Grant[],
  cap: Capability,
  service?: string,
  opts: { allowServiceEditorCreateService?: boolean } = {},
): boolean {
  const anyAuthenticated = grants.length > 0;
  switch (cap) {
    case "limits:read":
    case "usage:read":
    case "audit:read":
      return anyAuthenticated;
    case "limit:write":
    case "limit:delete":
    case "service:edit":
      return canEditService(grants, service);
    case "service:create":
      if (isOperatorOrAdmin(grants)) return true;
      return Boolean(opts.allowServiceEditorCreateService) && canEditService(grants, service);
    case "op:refund":
    case "op:reset":
    case "review:approve":
      return isOperatorOrAdmin(grants);
    case "rbac:manage":
      return hasGlobalRole(grants, "admin");
    default:
      return false;
  }
}
