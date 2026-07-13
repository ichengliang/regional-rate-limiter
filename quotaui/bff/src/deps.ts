// The dependency bundle threaded through the BFF. Injectable so integration tests
// can supply in-process gRPC backends and pre-seeded stores.
import type { Backends } from "./grpc.js";
import type { Policy } from "./rbac.js";
import { DEFAULT_POLICY } from "./rbac.js";
import type { ReviewPolicy } from "./policy.js";
import { DEFAULT_REVIEW_POLICY } from "./policy.js";
import { ActionLog } from "./actionlog.js";
import { ReviewStore } from "./reviews.js";
import { GrantStore, SessionStore } from "./session.js";

export interface AppDeps {
  backends: Backends;
  grants: GrantStore;
  sessions: SessionStore;
  authMode: "dev" | "oidc";
  policy: Policy;
  reviewPolicy: ReviewPolicy;
  actionLog: ActionLog;
  reviews: ReviewStore;
}

export function makeDeps(partial: {
  backends: Backends;
  grants?: GrantStore;
  sessions?: SessionStore;
  authMode?: "dev" | "oidc";
  policy?: Policy;
  reviewPolicy?: ReviewPolicy;
  actionLog?: ActionLog;
  reviews?: ReviewStore;
}): AppDeps {
  return {
    backends: partial.backends,
    grants: partial.grants ?? new GrantStore(),
    sessions: partial.sessions ?? new SessionStore(),
    authMode: partial.authMode ?? (process.env.AUTH_MODE === "oidc" ? "oidc" : "dev"),
    policy: partial.policy ?? DEFAULT_POLICY,
    reviewPolicy: partial.reviewPolicy ?? DEFAULT_REVIEW_POLICY,
    actionLog: partial.actionLog ?? new ActionLog(),
    reviews: partial.reviews ?? new ReviewStore(),
  };
}
