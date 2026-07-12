// When does a mutation require two-person review (design §9.2)? On by default for
// editing/deleting a '*' default and for window resets / large refunds on
// high-traffic keys. "High-traffic" detection is out of scope for the BFF, so we
// approximate with a refund-amount threshold; the rest is a per-deployment knob.
import type { PendingOp } from "./reviews.js";

export interface ReviewPolicy {
  reviewDefaultChanges: boolean; // edit/delete of a '*' default row
  reviewWindowResets: boolean; // any reset
  refundReviewThreshold: number; // refunds strictly above this need review
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  reviewDefaultChanges: true,
  reviewWindowResets: true,
  refundReviewThreshold: 100_000,
};

// Returns a human-readable reason string if review is required, else null.
export function reviewReason(op: PendingOp, policy: ReviewPolicy): string | null {
  switch (op.kind) {
    case "limit:update":
    case "limit:delete":
      if (policy.reviewDefaultChanges && op.customer_id === "*") {
        return `changes a '*' default for ${op.service_name}/${op.rate_limit_id} (affects all customers without an override)`;
      }
      return null;
    case "op:reset":
      return policy.reviewWindowResets ? "resets a customer's window" : null;
    case "op:refund":
      return op.amount > policy.refundReviewThreshold
        ? `large refund (${op.amount} > ${policy.refundReviewThreshold})`
        : null;
    default:
      return null;
  }
}
