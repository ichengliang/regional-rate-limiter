import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { startBackends, buildApp, login, USERS, type Harness } from "./helpers.js";
import type { AppDeps } from "../src/deps.js";

let h: Harness;
let app: Express;
let deps: AppDeps;

before(async () => {
  h = await startBackends();
});
after(async () => {
  await h.close();
});

// Fresh app + backend state per test.
beforeEach(() => {
  h.mgmt.limits.clear();
  h.mgmt.services.clear();
  h.mgmt.audit.length = 0;
  const built = buildApp(h, USERS);
  app = built.app;
  deps = built.deps;
});

test("healthz needs no auth", async () => {
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
});

test("unauthenticated /api is 401", async () => {
  const res = await request(app).get("/api/session");
  assert.equal(res.status, 401);
});

test("login returns session payload with grants + csrf", async () => {
  const { agent } = await login(app, "bob");
  const res = await agent.get("/api/session");
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, "bob@anthropic.com");
  assert.deepEqual(res.body.editable_services, ["search-svc"]);
});

test("unknown dev user cannot log in", async () => {
  const res = await request(app).post("/api/auth/login").send({ user: "mallory" });
  assert.equal(res.status, 401);
});

test("mutations require a CSRF token", async () => {
  const { agent } = await login(app, "alice");
  // no x-csrf-token header
  const res = await agent.post("/api/services").send({
    service_name: "s",
    display_name: "S",
    owner: "team",
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /CSRF/);
});

test("service create + limit CRUD happy path (operator)", async () => {
  const { agent, csrf } = await login(app, "alice");

  const svc = await agent
    .post("/api/services")
    .set("x-csrf-token", csrf)
    .send({ service_name: "search-svc", display_name: "Search", owner: "search-team" });
  assert.equal(svc.status, 201);

  const create = await agent
    .post("/api/limits")
    .set("x-csrf-token", csrf)
    .send({
      service_name: "search-svc",
      customer_id: "cust_42",
      rate_limit_id: "default",
      limit_value: 1000,
      time_unit: "MINUTE",
    });
  assert.equal(create.status, 201);
  assert.equal(create.body.limit_value, 1000);
  assert.equal(create.body.is_default, false);

  const list = await agent.get("/api/limits").query({ service_name: "search-svc" });
  assert.equal(list.status, 200);
  assert.equal(list.body.limits.length, 1);

  const upd = await agent
    .put("/api/limits")
    .set("x-csrf-token", csrf)
    .send({
      service_name: "search-svc",
      customer_id: "cust_42",
      rate_limit_id: "default",
      limit_value: 2000,
      time_unit: "MINUTE",
    });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.limit_value, 2000);

  const del = await agent
    .delete("/api/limits")
    .set("x-csrf-token", csrf)
    .send({ service_name: "search-svc", customer_id: "cust_42", rate_limit_id: "default" });
  assert.equal(del.status, 204);
});

test("audit-correctness: config change is attributed to the signed-in human (§4.4)", async () => {
  const { agent, csrf } = await login(app, "bob"); // service-editor of search-svc

  await agent
    .post("/api/limits")
    .set("x-csrf-token", csrf)
    .send({
      service_name: "search-svc",
      customer_id: "cust_1",
      rate_limit_id: "default",
      limit_value: 10,
      time_unit: "DAY",
    });

  // The fake quotamgmt only writes audit when it receives the x-actor metadata,
  // exactly mirroring the SET LOCAL app.actor trigger guard.
  const audit = await agent.get("/api/audit").query({ service_name: "search-svc" });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.entries.length, 1);
  assert.equal(audit.body.entries[0].changed_by, "bob@anthropic.com");
  assert.equal(audit.body.entries[0].operation, "INSERT");
  assert.equal(audit.body.entries[0].new_row.limit_value, 10);
});

test("RBAC: viewer cannot create a limit (403), even with a valid CSRF token", async () => {
  const { agent, csrf } = await login(app, "vic");
  const res = await agent
    .post("/api/limits")
    .set("x-csrf-token", csrf)
    .send({
      service_name: "search-svc",
      customer_id: "c",
      rate_limit_id: "r",
      limit_value: 1,
      time_unit: "MINUTE",
    });
  assert.equal(res.status, 403);
});

test("RBAC: service-editor cannot touch a service it does not own (403)", async () => {
  const { agent, csrf } = await login(app, "bob"); // owns search-svc only
  const res = await agent
    .post("/api/limits")
    .set("x-csrf-token", csrf)
    .send({
      service_name: "payments-svc",
      customer_id: "c",
      rate_limit_id: "r",
      limit_value: 1,
      time_unit: "MINUTE",
    });
  assert.equal(res.status, 403);
});

test("RBAC: service-editor cannot issue a refund (operator-only)", async () => {
  const { agent, csrf } = await login(app, "bob");
  const res = await agent
    .post("/api/ops/refund")
    .set("x-csrf-token", csrf)
    .send({ service_name: "search-svc", customer_id: "c", rate_limit_id: "r", amount: 5 });
  assert.equal(res.status, 403);
});

test("create conflict surfaces as 409 (uq_limit)", async () => {
  const { agent, csrf } = await login(app, "alice");
  const body = {
    service_name: "search-svc",
    customer_id: "cust_42",
    rate_limit_id: "default",
    limit_value: 1000,
    time_unit: "MINUTE",
  };
  await agent.post("/api/limits").set("x-csrf-token", csrf).send(body);
  const dup = await agent.post("/api/limits").set("x-csrf-token", csrf).send(body);
  assert.equal(dup.status, 409);
});

test("resolve returns the '*' default when no exact override, and unconfigured otherwise", async () => {
  const { agent, csrf } = await login(app, "alice");
  await agent.post("/api/limits").set("x-csrf-token", csrf).send({
    service_name: "search-svc",
    customer_id: "*",
    rate_limit_id: "export",
    limit_value: 5,
    time_unit: "DAY",
  });

  const resolved = await agent
    .get("/api/limits/resolve")
    .query({ service_name: "search-svc", customer_id: "cust_99", rate_limit_id: "export" });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.configured, true);
  assert.equal(resolved.body.is_default, true);
  assert.equal(resolved.body.limit_value, 5);

  const missing = await agent
    .get("/api/limits/resolve")
    .query({ service_name: "search-svc", customer_id: "cust_99", rate_limit_id: "nope" });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.configured, false);
  assert.match(missing.body.note, /fail-open/);
});

test("live usage reflects the enforcer read API, negative remaining allowed (§6.4)", async () => {
  const key = { service_name: "search-svc", customer_id: "cust_42", rate_limit_id: "default" };
  h.enforcer.seed(key, { consumed: 1003, limit: 1000 });
  const { agent } = await login(app, "vic");
  const res = await agent.get("/api/usage").query(key);
  assert.equal(res.status, 200);
  assert.equal(res.body.consumed, 1003);
  assert.equal(res.body.remaining, -3);
  assert.equal(res.body.limit, 1000);
  assert.ok(res.body.fetched_at);
});

test("refund below threshold applies immediately and carries the actor", async () => {
  const key = { service_name: "search-svc", customer_id: "cust_42", rate_limit_id: "default" };
  h.enforcer.seed(key, { consumed: 50, limit: 1000 });
  const { agent, csrf } = await login(app, "alice");
  const res = await agent
    .post("/api/ops/refund")
    .set("x-csrf-token", csrf)
    .send({ ...key, amount: 20 });
  assert.equal(res.status, 200);
  assert.equal(res.body.remaining, 1000 - 30);
  assert.equal(h.enforcer.lastRefund?.actor, "alice@anthropic.com");
  assert.equal(h.enforcer.get(key)?.consumed, 30);
});

test("two-person review: reset enters pending, initiator cannot approve, second operator applies", async () => {
  const key = { service_name: "search-svc", customer_id: "cust_42", rate_limit_id: "default" };
  h.enforcer.seed(key, { consumed: 900, limit: 1000 });

  // alice (operator) initiates a window reset → pending review (default policy).
  const alice = await login(app, "alice");
  const init = await alice.agent
    .post("/api/ops/reset")
    .set("x-csrf-token", alice.csrf)
    .send(key);
  assert.equal(init.status, 202);
  assert.equal(init.body.status, "pending_review");
  const reviewId = init.body.review.id;

  // Not applied yet.
  assert.equal(h.enforcer.get(key)?.consumed, 900);

  // alice cannot approve her own change (§1.4 note ²).
  const selfApprove = await alice.agent
    .post(`/api/reviews/${reviewId}/approve`)
    .set("x-csrf-token", alice.csrf)
    .send({});
  assert.equal(selfApprove.status, 403);

  // carol (a different operator) approves → the reset applies as a refund of consumed.
  const carol = await login(app, "carol");
  const approve = await carol.agent
    .post(`/api/reviews/${reviewId}/approve`)
    .set("x-csrf-token", carol.csrf)
    .send({});
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, "approved");
  assert.equal(h.enforcer.get(key)?.consumed, 0); // fully reset

  // action log records the initiator/approver pair (§9.3).
  const log = await carol.agent.get("/api/actionlog");
  const resetEntry = log.body.entries.find((e: any) => e.action === "op:reset");
  assert.ok(resetEntry);
  assert.equal(resetEntry.initiator, "alice@anthropic.com");
  assert.equal(resetEntry.approver, "carol@anthropic.com");
});

test("two-person review: editing a '*' default is gated then applied on approval", async () => {
  const alice = await login(app, "alice");
  const op = {
    service_name: "search-svc",
    customer_id: "*",
    rate_limit_id: "export",
    limit_value: 7,
    time_unit: "DAY",
  };
  const init = await alice.agent.put("/api/limits").set("x-csrf-token", alice.csrf).send(op);
  assert.equal(init.status, 202);

  // Not written yet.
  const before = await alice.agent
    .get("/api/limits/resolve")
    .query({ service_name: "search-svc", customer_id: "*", rate_limit_id: "export" });
  assert.equal(before.body.configured, false);

  const carol = await login(app, "carol");
  const approve = await carol.agent
    .post(`/api/reviews/${init.body.review.id}/approve`)
    .set("x-csrf-token", carol.csrf)
    .send({});
  assert.equal(approve.status, 200);

  // Now the default exists, attributed to the approver (the applying identity).
  const after = await alice.agent
    .get("/api/limits/resolve")
    .query({ service_name: "search-svc", customer_id: "*", rate_limit_id: "export" });
  assert.equal(after.body.configured, true);
  assert.equal(after.body.limit_value, 7);

  const audit = await carol.agent
    .get("/api/audit")
    .query({ service_name: "search-svc" });
  assert.equal(audit.body.entries[0].changed_by, "carol@anthropic.com");
});

test("reject discards a pending review without applying", async () => {
  const key = { service_name: "search-svc", customer_id: "cust_42", rate_limit_id: "default" };
  h.enforcer.seed(key, { consumed: 900, limit: 1000 });
  const alice = await login(app, "alice");
  const init = await alice.agent.post("/api/ops/reset").set("x-csrf-token", alice.csrf).send(key);
  const carol = await login(app, "carol");
  const rej = await carol.agent
    .post(`/api/reviews/${init.body.review.id}/reject`)
    .set("x-csrf-token", carol.csrf)
    .send({});
  assert.equal(rej.status, 200);
  assert.equal(rej.body.status, "rejected");
  assert.equal(h.enforcer.get(key)?.consumed, 900); // untouched
});
