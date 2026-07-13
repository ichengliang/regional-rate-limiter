// Audit / History Browser (§2.6) → quotamgmt ListAuditEntries (§5.5).
//
// The proto's ListAuditEntriesRequest supports service_name (required), an
// optional key (tuple), config_id, and `since`. It does NOT support changed_by /
// operation filters, so — being a control-plane client — the BFF passes what the
// proto supports and applies changed_by / operation as post-filters (§8.2: this
// traffic is a rounding error against real load).
import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { call, toAuditView } from "../rpc.js";
import { asyncHandler, guard } from "./util.js";
import type { AuditView } from "../types.js";

function isoToTimestamp(iso: string | undefined): { seconds: number; nanos: number } | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
}

export function auditRouter(deps: AppDeps): Router {
  const r = Router();

  // GET /api/audit?service_name=&customer_id=&rate_limit_id=&config_id=&since=
  //             &changed_by=&operation=&page_size=&page_token=
  r.get(
    "/",
    asyncHandler(async (req, res) => {
      const service_name = String(req.query.service_name ?? "");
      if (!service_name) {
        res.status(400).json({ error: "service_name is required" });
        return;
      }
      if (!guard(req, res, deps, "audit:read", service_name)) return;

      const key =
        req.query.customer_id && req.query.rate_limit_id
          ? {
              service_name,
              customer_id: String(req.query.customer_id),
              rate_limit_id: String(req.query.rate_limit_id),
            }
          : undefined;

      const resp = await call<{ entries: never[]; next_page_token: string }>(
        deps.backends.quotamgmt,
        "ListAuditEntries",
        {
          service_name,
          key,
          config_id: req.query.config_id ? Number(req.query.config_id) : 0,
          since: isoToTimestamp(req.query.since ? String(req.query.since) : undefined),
          page_size: req.query.page_size ? Number(req.query.page_size) : 0,
          page_token: req.query.page_token ? String(req.query.page_token) : "",
        },
      );

      let entries: AuditView[] = (resp.entries ?? []).map(toAuditView);
      const changedBy = req.query.changed_by ? String(req.query.changed_by) : "";
      const operation = req.query.operation ? String(req.query.operation).toUpperCase() : "";
      if (changedBy) entries = entries.filter((e) => e.changed_by === changedBy);
      if (operation) entries = entries.filter((e) => e.operation === operation);

      res.json({ entries, next_page_token: resp.next_page_token || null });
    }),
  );

  // GET /api/audit/config/:configId — history for one config_id (deep-linked from
  // the Limits Browser/Editor). service_name is required by the RPC for scope.
  r.get(
    "/config/:configId",
    asyncHandler(async (req, res) => {
      const service_name = String(req.query.service_name ?? "");
      if (!service_name) {
        res.status(400).json({ error: "service_name is required" });
        return;
      }
      if (!guard(req, res, deps, "audit:read", service_name)) return;
      const resp = await call<{ entries: never[]; next_page_token: string }>(
        deps.backends.quotamgmt,
        "ListAuditEntries",
        { service_name, config_id: Number(req.params.configId), page_size: 0, page_token: "" },
      );
      res.json({ entries: (resp.entries ?? []).map(toAuditView) });
    }),
  );

  return r;
}
