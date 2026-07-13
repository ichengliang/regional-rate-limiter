// Service Registration / Management (§2.3) → quotamgmt (§5.4).
// The proto exposes RegisterService (upsert) + GetService + ListServices — there
// is no separate UpdateService RPC, so create and edit both map to RegisterService
// (create = new service_name; edit = same service_name, changed display_name/owner).
import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { actorMetadata, call, toServiceView } from "../rpc.js";
import { asyncHandler, guard } from "./util.js";

function validateServiceBody(body: {
  service_name?: unknown;
  display_name?: unknown;
  owner?: unknown;
}): { ok: true; value: { service_name: string; display_name: string; owner: string } } | {
  ok: false;
  errors: string[];
} {
  const errors: string[] = [];
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  if (!s(body.service_name)) errors.push("service_name is required");
  if (!s(body.display_name)) errors.push("display_name is required");
  if (!s(body.owner)) errors.push("owner is required");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      service_name: s(body.service_name),
      display_name: s(body.display_name),
      owner: s(body.owner),
    },
  };
}

export function servicesRouter(deps: AppDeps): Router {
  const r = Router();

  // GET /api/services — ListServices.
  r.get(
    "/",
    asyncHandler(async (req, res) => {
      if (!guard(req, res, deps, "limits:read")) return;
      const resp = await call<{ services: never[]; next_page_token: string }>(
        deps.backends.quotamgmt,
        "ListServices",
        {
          page_size: req.query.page_size ? Number(req.query.page_size) : 0,
          page_token: req.query.page_token ? String(req.query.page_token) : "",
        },
      );
      res.json({
        services: (resp.services ?? []).map(toServiceView),
        next_page_token: resp.next_page_token || null,
      });
    }),
  );

  // GET /api/services/:name — GetService.
  r.get(
    "/:name",
    asyncHandler(async (req, res) => {
      if (!guard(req, res, deps, "limits:read")) return;
      const resp = await call<{ service: never }>(deps.backends.quotamgmt, "GetService", {
        service_name: req.params.name,
      });
      res.json(toServiceView(resp.service));
    }),
  );

  // POST /api/services — create a new service (gated per §1.4 note ¹).
  r.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = validateServiceBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      if (!guard(req, res, deps, "service:create", parsed.value.service_name)) return;
      const resp = await call<{ service: never }>(
        deps.backends.quotamgmt,
        "RegisterService",
        { service: parsed.value },
        actorMetadata(req.session!.user.email),
      );
      deps.actionLog.append({
        actor: req.session!.user.email,
        action: "service:create",
        target: { service_name: parsed.value.service_name },
        details: { display_name: parsed.value.display_name, owner: parsed.value.owner },
      });
      res.status(201).json(toServiceView(resp.service));
    }),
  );

  // PUT /api/services/:name — edit display_name/owner (RegisterService upsert).
  // service_name is immutable (it is the FK target); the path name wins over body.
  r.put(
    "/:name",
    asyncHandler(async (req, res) => {
      const body = { ...req.body, service_name: req.params.name };
      const parsed = validateServiceBody(body);
      if (!parsed.ok) {
        res.status(400).json({ errors: parsed.errors });
        return;
      }
      if (!guard(req, res, deps, "service:edit", parsed.value.service_name)) return;
      const resp = await call<{ service: never }>(
        deps.backends.quotamgmt,
        "RegisterService",
        { service: parsed.value },
        actorMetadata(req.session!.user.email),
      );
      deps.actionLog.append({
        actor: req.session!.user.email,
        action: "service:edit",
        target: { service_name: parsed.value.service_name },
        details: { display_name: parsed.value.display_name, owner: parsed.value.owner },
      });
      res.json(toServiceView(resp.service));
    }),
  );

  return r;
}
