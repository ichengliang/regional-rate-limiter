// Limits Browser (§2.1) + Limit Editor (§2.2) → quotamgmt config API (§5.1).
import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { call, toLimitView } from "../rpc.js";
import { validateLimit, validateKey } from "../validation.js";
import { reviewReason } from "../policy.js";
import { createLimit, updateLimit, deleteLimit } from "../operations.js";
import type { PendingOp } from "../reviews.js";
import { asyncHandler, guard, opContext } from "./util.js";
import type { LimitView } from "../types.js";

export function limitsRouter(deps: AppDeps): Router {
  const r = Router();

  // GET /api/limits — ListLimits (service_name required for RBAC scope).
  r.get(
    "/",
    asyncHandler(async (req, res) => {
      const service_name = String(req.query.service_name ?? "");
      if (!service_name) {
        res.status(400).json({ error: "service_name is required" });
        return;
      }
      if (!guard(req, res, deps, "limits:read", service_name)) return;
      const resp = await call<{ limits: never[]; next_page_token: string }>(
        deps.backends.quotamgmt,
        "ListLimits",
        {
          service_name,
          customer_id: req.query.customer_id ? String(req.query.customer_id) : "",
          rate_limit_id: req.query.rate_limit_id ? String(req.query.rate_limit_id) : "",
          page_size: req.query.page_size ? Number(req.query.page_size) : 0,
          page_token: req.query.page_token ? String(req.query.page_token) : "",
        },
      );
      res.json({
        limits: (resp.limits ?? []).map((l) => toLimitView(l)),
        next_page_token: resp.next_page_token || null,
      });
    }),
  );

  // GET /api/limits/resolve — effective limit for a concrete customer (§2.1 hint):
  // the exact override if any, else the '*' default; 404-shaped "unconfigured".
  r.get(
    "/resolve",
    asyncHandler(async (req, res) => {
      const parsed = validateKey(req.query);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      if (!guard(req, res, deps, "limits:read", parsed.value.service_name)) return;
      try {
        const resp = await call<{ limit: never; is_default: boolean }>(
          deps.backends.quotamgmt,
          "GetLimit",
          { key: parsed.value, resolve: true },
        );
        res.json({ configured: true, ...toLimitView(resp.limit, resp.is_default) });
      } catch (e) {
        // Unconfigured → allow (fail-open, parent §9) — a real, non-obvious state.
        if (e && (e as { httpStatus?: number }).httpStatus === 404) {
          res.json({
            configured: false,
            note: "unconfigured → allow (fail-open, parent §9)",
            ...parsed.value,
          });
          return;
        }
        throw e;
      }
    }),
  );

  // POST /api/limits — CreateLimit.
  r.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = validateLimit(req.body);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      const v = parsed.value;
      if (!guard(req, res, deps, "limit:write", v.service_name)) return;
      const limit: LimitView = await createLimit(opContext(req, deps), v);
      res.status(201).json(limit);
    }),
  );

  // PUT /api/limits — UpdateLimit (optional upsert via create_if_absent).
  r.put(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = validateLimit(req.body);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      const v = parsed.value;
      if (!guard(req, res, deps, "limit:write", v.service_name)) return;

      const op: PendingOp = { kind: "limit:update", ...v, time_unit: v.time_unit };
      const reason = reviewReason(op, deps.reviewPolicy);
      if (reason) {
        const review = deps.reviews.create(op, req.session!.user.email, reason);
        res.status(202).json({ status: "pending_review", review });
        return;
      }
      const limit = await updateLimit(opContext(req, deps), {
        ...v,
        create_if_absent: Boolean(req.body?.create_if_absent),
      });
      res.json(limit);
    }),
  );

  // DELETE /api/limits — DeleteLimit (key in body).
  r.delete(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = validateKey(req.body);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      const v = parsed.value;
      if (!guard(req, res, deps, "limit:delete", v.service_name)) return;

      const op: PendingOp = { kind: "limit:delete", ...v };
      const reason = reviewReason(op, deps.reviewPolicy);
      if (reason) {
        const review = deps.reviews.create(op, req.session!.user.email, reason);
        res.status(202).json({ status: "pending_review", review });
        return;
      }
      await deleteLimit(opContext(req, deps), { ...v, allow_missing: Boolean(req.body?.allow_missing) });
      res.status(204).end();
    }),
  );

  return r;
}
