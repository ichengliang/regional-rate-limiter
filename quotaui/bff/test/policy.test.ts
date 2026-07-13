import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewReason, DEFAULT_REVIEW_POLICY } from "../src/policy.js";
import type { PendingOp } from "../src/reviews.js";

const P = DEFAULT_REVIEW_POLICY;

test("editing a '*' default requires review", () => {
  const op: PendingOp = {
    kind: "limit:update",
    service_name: "s",
    customer_id: "*",
    rate_limit_id: "r",
    limit_value: 5,
    time_unit: "MINUTE",
  };
  assert.ok(reviewReason(op, P));
});

test("editing a concrete customer does not require review", () => {
  const op: PendingOp = {
    kind: "limit:update",
    service_name: "s",
    customer_id: "cust_1",
    rate_limit_id: "r",
    limit_value: 5,
    time_unit: "MINUTE",
  };
  assert.equal(reviewReason(op, P), null);
});

test("deleting a '*' default requires review", () => {
  const op: PendingOp = { kind: "limit:delete", service_name: "s", customer_id: "*", rate_limit_id: "r" };
  assert.ok(reviewReason(op, P));
});

test("window reset requires review by default", () => {
  const op: PendingOp = { kind: "op:reset", service_name: "s", customer_id: "c", rate_limit_id: "r" };
  assert.ok(reviewReason(op, P));
});

test("large refund requires review, small does not", () => {
  const base = { kind: "op:refund" as const, service_name: "s", customer_id: "c", rate_limit_id: "r" };
  assert.equal(reviewReason({ ...base, amount: 10 }, P), null);
  assert.ok(reviewReason({ ...base, amount: P.refundReviewThreshold + 1 }, P));
});

test("knobs can turn review off", () => {
  const off = { reviewDefaultChanges: false, reviewWindowResets: false, refundReviewThreshold: Infinity };
  const del: PendingOp = { kind: "limit:delete", service_name: "s", customer_id: "*", rate_limit_id: "r" };
  const reset: PendingOp = { kind: "op:reset", service_name: "s", customer_id: "c", rate_limit_id: "r" };
  assert.equal(reviewReason(del, off), null);
  assert.equal(reviewReason(reset, off), null);
});
