import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, editableServices, DEFAULT_POLICY, type User } from "../src/rbac.js";

const viewer: User = { id: "v", email: "v@x", grants: [{ role: "viewer" }] };
const editor: User = {
  id: "e",
  email: "e@x",
  grants: [{ role: "service-editor", service: "search-svc" }],
};
const operator: User = { id: "o", email: "o@x", grants: [{ role: "operator" }] };
const admin: User = { id: "a", email: "a@x", grants: [{ role: "admin" }] };

test("all authenticated roles can read", () => {
  for (const u of [viewer, editor, operator, admin]) {
    assert.ok(authorize(u, "limits:read", "search-svc").ok);
    assert.ok(authorize(u, "usage:read", "search-svc").ok);
    assert.ok(authorize(u, "audit:read", "search-svc").ok);
  }
});

test("viewer cannot write", () => {
  assert.equal(authorize(viewer, "limit:write", "search-svc").ok, false);
  assert.equal(authorize(viewer, "limit:delete", "search-svc").ok, false);
  assert.equal(authorize(viewer, "op:refund", "search-svc").ok, false);
});

test("service-editor may write only its own service", () => {
  assert.ok(authorize(editor, "limit:write", "search-svc").ok);
  assert.ok(authorize(editor, "limit:delete", "search-svc").ok);
  assert.equal(authorize(editor, "limit:write", "payments-svc").ok, false);
});

test("service-editor cannot do manual ops or approve reviews", () => {
  assert.equal(authorize(editor, "op:refund", "search-svc").ok, false);
  assert.equal(authorize(editor, "op:reset", "search-svc").ok, false);
  assert.equal(authorize(editor, "review:approve", undefined).ok, false);
});

test("operator has cross-service write + manual ops", () => {
  assert.ok(authorize(operator, "limit:write", "payments-svc").ok);
  assert.ok(authorize(operator, "op:refund", "payments-svc").ok);
  assert.ok(authorize(operator, "op:reset", "payments-svc").ok);
  assert.ok(authorize(operator, "review:approve", undefined).ok);
});

test("only admin manages RBAC", () => {
  assert.equal(authorize(operator, "rbac:manage", undefined).ok, false);
  assert.ok(authorize(admin, "rbac:manage", undefined).ok);
});

test("service creation is gated to operator/admin by default", () => {
  assert.equal(authorize(editor, "service:create", "search-svc").ok, false);
  assert.ok(authorize(operator, "service:create", "new-svc").ok);
  // knob: allow editors to create their own service
  const openPolicy = { ...DEFAULT_POLICY, allowServiceEditorCreateService: true };
  assert.ok(authorize(editor, "service:create", "search-svc", openPolicy).ok);
  assert.equal(authorize(editor, "service:create", "other-svc", openPolicy).ok, false);
});

test("service-scoped write requires a service argument", () => {
  assert.equal(authorize(operator, "limit:write", undefined).ok, false);
});

test("editableServices lists the editor's scoped services", () => {
  assert.deepEqual(editableServices(editor), ["search-svc"]);
  assert.deepEqual(editableServices(operator), []);
});

test("a user can hold different roles on different services", () => {
  const mixed: User = {
    id: "m",
    email: "m@x",
    grants: [
      { role: "service-editor", service: "search-svc" },
      { role: "viewer" },
    ],
  };
  assert.ok(authorize(mixed, "limit:write", "search-svc").ok);
  assert.equal(authorize(mixed, "limit:write", "payments-svc").ok, false);
  assert.ok(authorize(mixed, "audit:read", "payments-svc").ok); // viewer read everywhere
});

test("no grants ⇒ nothing", () => {
  const nobody: User = { id: "n", email: "n@x", grants: [] };
  assert.equal(authorize(nobody, "limits:read", "search-svc").ok, false);
});
