// Two-person review queue (§9.2). A pending change is applied only when a
// *different* operator/admin approves it (initiator ≠ approver, §1.4 note ²).
import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { executePendingOp } from "../operations.js";
import { asyncHandler, guard } from "./util.js";

export function reviewsRouter(deps: AppDeps): Router {
  const r = Router();

  // GET /api/reviews — pending reviews awaiting a checker.
  r.get(
    "/",
    asyncHandler(async (req, res) => {
      if (!guard(req, res, deps, "review:approve")) return;
      res.json({ reviews: deps.reviews.listPending() });
    }),
  );

  // POST /api/reviews/:id/approve — apply the change as the approver (the applying
  // identity, design §9.2), recording the initiator/approver pair in the log.
  r.post(
    "/:id/approve",
    asyncHandler(async (req, res) => {
      if (!guard(req, res, deps, "review:approve")) return;
      const approver = req.session!.user.email;
      const decision = deps.reviews.decide(req.params.id, approver, "approved");
      if (!decision.ok) {
        res.status(decision.status).json({ error: decision.error });
        return;
      }
      const result = await executePendingOp(
        {
          backends: deps.backends,
          actionLog: deps.actionLog,
          actor: approver,
          initiator: decision.review.initiator,
          approver,
        },
        decision.review.op,
      );
      res.json({ status: "approved", review: decision.review, result });
    }),
  );

  // POST /api/reviews/:id/reject — discard the pending change.
  r.post(
    "/:id/reject",
    asyncHandler(async (req, res) => {
      if (!guard(req, res, deps, "review:approve")) return;
      const decision = deps.reviews.decide(req.params.id, req.session!.user.email, "rejected");
      if (!decision.ok) {
        res.status(decision.status).json({ error: decision.error });
        return;
      }
      res.json({ status: "rejected", review: decision.review });
    }),
  );

  return r;
}
