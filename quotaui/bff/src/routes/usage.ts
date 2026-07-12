// Live Usage Viewer (§2.4) → quotaenforcer GetUsage read API (§5.2).
// Read-only; fronts Redis. Never cached at the BFF (§8.3) — staleness misleads.
import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { call, toUsageView } from "../rpc.js";
import { validateKey } from "../validation.js";
import { asyncHandler, guard } from "./util.js";

export function usageRouter(deps: AppDeps): Router {
  const r = Router();

  // GET /api/usage?service_name=&customer_id=&rate_limit_id=
  r.get(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = validateKey(req.query);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      if (!guard(req, res, deps, "usage:read", parsed.value.service_name)) return;

      const fetchedAt = new Date().toISOString();
      const resp = await call<{
        consumed: string | number;
        remaining: string | number;
        limit: string | number;
        reset_at: unknown;
        configured: boolean;
      }>(deps.backends.quotaenforcer, "GetUsage", { key: parsed.value });

      res.json(toUsageView(parsed.value, resp, fetchedAt));
    }),
  );

  return r;
}
