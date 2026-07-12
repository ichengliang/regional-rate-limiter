import { test } from "node:test";
import assert from "node:assert/strict";
import { canDo, type Grant } from "../src/util/rbac";

const viewer: Grant[] = [{ role: "viewer" }];
const editor: Grant[] = [{ role: "service-editor", service: "search-svc" }];
const operator: Grant[] = [{ role: "operator" }];
const admin: Grant[] = [{ role: "admin" }];

test("frontend RBAC mirror matches BFF semantics for UX gating", () => {
  // viewer: read yes, write no
  assert.equal(canDo(viewer, "limits:read"), true);
  assert.equal(canDo(viewer, "limit:write", "search-svc"), false);

  // editor: scoped write
  assert.equal(canDo(editor, "limit:write", "search-svc"), true);
  assert.equal(canDo(editor, "limit:write", "payments-svc"), false);
  assert.equal(canDo(editor, "op:refund", "search-svc"), false);

  // operator: cross-service + ops + approvals
  assert.equal(canDo(operator, "limit:write", "anything"), true);
  assert.equal(canDo(operator, "op:reset", "anything"), true);
  assert.equal(canDo(operator, "review:approve"), true);

  // admin only for RBAC management
  assert.equal(canDo(operator, "rbac:manage"), false);
  assert.equal(canDo(admin, "rbac:manage"), true);
});

test("service creation gating knob", () => {
  assert.equal(canDo(editor, "service:create", "search-svc"), false);
  assert.equal(
    canDo(editor, "service:create", "search-svc", { allowServiceEditorCreateService: true }),
    true,
  );
  assert.equal(canDo(operator, "service:create", "new-svc"), true);
});
