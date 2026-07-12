// Manual Operations (§2.5) → quotaenforcer op API (§5.3). operator+ only.
// These map onto the existing Refund path — no backdoor (parent §5.1). A "reset"
// is a Refund of the current consumed (operations.resetWindow).
import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { validateKey, validateAmount } from "../validation.js";
import { reviewReason } from "../policy.js";
import { refund, resetWindow } from "../operations.js";
import type { PendingOp } from "../reviews.js";
import { asyncHandler, guard, opContext } from "./util.js";

export function opsRouter(deps: AppDeps): Router {
  const r = Router();

  // POST /api/ops/refund { service_name, customer_id, rate_limit_id, amount }
  r.post(
    "/refund",
    asyncHandler(async (req, res) => {
      const parsedKey = validateKey(req.body);
      if (!parsedKey.ok) {
        res.status(400).json({ errors: parsedKey.errors });
        return;
      }
      const parsedAmount = validateAmount(req.body?.amount);
      if (!parsedAmount.ok) {
        res.status(400).json({ error: parsedAmount.error });
        return;
      }
      if (!guard(req, res, deps, "op:refund", parsedKey.value.service_name)) return;

      const op: PendingOp = { kind: "op:refund", ...parsedKey.value, amount: parsedAmount.value };
      const reason = reviewReason(op, deps.reviewPolicy);
      if (reason) {
        const review = deps.reviews.create(op, req.session!.user.email, reason);
        res.status(202).json({ status: "pending_review", review });
        return;
      }
      const result = await refund(opContext(req, deps), {
        ...parsedKey.value,
        amount: parsedAmount.value,
      });
      res.json(result);
    }),
  );

  // POST /api/ops/reset { service_name, customer_id, rate_limit_id }
  r.post(
    "/reset",
    asyncHandler(async (req, res) => {
      const parsedKey = validateKey(req.body);
      if (!parsedKey.ok) {
        res.status(400).json({ errors: parsedKey.errors });
        return;
      }
      if (!guard(req, res, deps, "op:reset", parsedKey.value.service_name)) return;

      const op: PendingOp = { kind: "op:reset", ...parsedKey.value };
      const reason = reviewReason(op, deps.reviewPolicy);
      if (reason) {
        const review = deps.reviews.create(op, req.session!.user.email, reason);
        res.status(202).json({ status: "pending_review", review });
        return;
      }
      const result = await resetWindow(opContext(req, deps), parsedKey.value);
      res.json(result);
    }),
  );

  return r;
}
