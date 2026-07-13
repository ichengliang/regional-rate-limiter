// Typed client for the BFF's same-origin /api routes. The SPA never calls
// quotamgmt/quotaenforcer directly (design §3, §5) — only the BFF does. The
// session cookie is HttpOnly (sent automatically with credentials:'include'); the
// CSRF token is echoed on every mutating request (§4.2).
import type {
  AuditView,
  Key,
  LimitView,
  ResolveView,
  Review,
  ServiceView,
  SessionInfo,
  TimeUnit,
  UsageView,
} from "./types";

let csrfToken = "";
export function setCsrf(token: string): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const mutating = method !== "GET";
  if (body !== undefined) headers["content-type"] = "application/json";
  if (mutating) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg =
      parsed?.error ?? (parsed?.errors ? parsed.errors.join("; ") : `HTTP ${res.status}`);
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// A mutating limit/op call may return 202 pending_review instead of the result.
export interface PendingReview {
  status: "pending_review";
  review: Review;
}
function isPending(x: unknown): x is PendingReview {
  return typeof x === "object" && x !== null && (x as { status?: string }).status === "pending_review";
}

export const api = {
  // auth / session
  login: (user: string) => req<SessionInfo>("POST", "/auth/login", { user }),
  logout: () => req<{ ok: boolean }>("POST", "/auth/logout"),
  session: () => req<SessionInfo>("GET", "/session"),

  // limits
  listLimits: (p: { service_name: string; customer_id?: string; rate_limit_id?: string }) =>
    req<{ limits: LimitView[]; next_page_token: string | null }>("GET", `/limits${qs(p)}`),
  resolveLimit: (k: Key) => req<ResolveView>("GET", `/limits/resolve${qs({ ...k })}`),
  createLimit: (b: LimitView) => req<LimitView>("POST", "/limits", b),
  updateLimit: (b: LimitView & { create_if_absent?: boolean }) =>
    req<LimitView | PendingReview>("PUT", "/limits", b),
  deleteLimit: (k: Key & { allow_missing?: boolean }) =>
    req<undefined | PendingReview>("DELETE", "/limits", k),

  // services
  listServices: () => req<{ services: ServiceView[] }>("GET", "/services"),
  createService: (b: ServiceView) => req<ServiceView>("POST", "/services", b),
  updateService: (name: string, b: Omit<ServiceView, "service_name">) =>
    req<ServiceView>("PUT", `/services/${encodeURIComponent(name)}`, b),

  // usage + manual ops
  getUsage: (k: Key) => req<UsageView>("GET", `/usage${qs({ ...k })}`),
  refund: (b: Key & { amount: number }) =>
    req<{ remaining: number; limit: number } | PendingReview>("POST", "/ops/refund", b),
  reset: (b: Key) => req<UsageView | PendingReview>("POST", "/ops/reset", b),

  // audit
  listAudit: (p: {
    service_name: string;
    customer_id?: string;
    rate_limit_id?: string;
    config_id?: number;
    changed_by?: string;
    operation?: string;
    since?: string;
  }) => req<{ entries: AuditView[] }>("GET", `/audit${qs(p)}`),

  // reviews
  listReviews: () => req<{ reviews: Review[] }>("GET", "/reviews"),
  approveReview: (id: string) => req<{ status: string; review: Review }>("POST", `/reviews/${id}/approve`),
  rejectReview: (id: string) => req<{ status: string; review: Review }>("POST", `/reviews/${id}/reject`),
};

export { isPending };
export type { TimeUnit };
