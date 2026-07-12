// Two-person (maker-checker) review for high-blast-radius ops (design §9.2).
//
// On by default for: editing/deleting a '*' default, window resets, and large
// refunds. The initiator submits a change that enters `pending` and is NOT
// applied; a *different* operator/admin approves (initiator may not approve their
// own — §1.4 note ²). Only on approval does the BFF call the backend.
import { randomBytes } from "node:crypto";

// The concrete mutation a review will apply once approved. Discriminated so the
// executor can dispatch. Kept minimal (design: "minimal maker-checker").
export type PendingOp =
  | {
      kind: "limit:update";
      service_name: string;
      customer_id: string;
      rate_limit_id: string;
      limit_value: number;
      time_unit: string;
    }
  | {
      kind: "limit:delete";
      service_name: string;
      customer_id: string;
      rate_limit_id: string;
    }
  | {
      kind: "op:refund";
      service_name: string;
      customer_id: string;
      rate_limit_id: string;
      amount: number;
    }
  | {
      kind: "op:reset";
      service_name: string;
      customer_id: string;
      rate_limit_id: string;
    };

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface Review {
  id: string;
  op: PendingOp;
  reason: string; // why review was required (for the reviewer)
  initiator: string;
  status: ReviewStatus;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export class ReviewStore {
  private reviews = new Map<string, Review>();

  create(op: PendingOp, initiator: string, reason: string): Review {
    const r: Review = {
      id: randomBytes(12).toString("hex"),
      op,
      reason,
      initiator,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.reviews.set(r.id, r);
    return r;
  }

  get(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  listPending(): Review[] {
    return [...this.reviews.values()].filter((r) => r.status === "pending");
  }

  // Mark a decision. Guards initiator≠approver (§1.4 note ²) and pending-state.
  decide(
    id: string,
    approver: string,
    decision: "approved" | "rejected",
  ): { ok: true; review: Review } | { ok: false; status: number; error: string } {
    const r = this.reviews.get(id);
    if (!r) return { ok: false, status: 404, error: "review not found" };
    if (r.status !== "pending") {
      return { ok: false, status: 409, error: `review already ${r.status}` };
    }
    if (r.initiator === approver) {
      return { ok: false, status: 403, error: "the initiator may not approve their own change" };
    }
    r.status = decision;
    r.decidedBy = approver;
    r.decidedAt = new Date().toISOString();
    return { ok: true, review: r };
  }
}
