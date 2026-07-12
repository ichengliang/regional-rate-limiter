import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLimit, validateKey, validateAmount } from "../src/validation.js";

test("valid limit passes and is cleaned", () => {
  const r = validateLimit({
    service_name: "search-svc",
    customer_id: "cust_42",
    rate_limit_id: "default",
    limit_value: 1000,
    time_unit: "MINUTE",
  });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.limit_value, 1000);
});

test("limit_value must be >= 0 (mirrors CHECK)", () => {
  const r = validateLimit({
    service_name: "s",
    customer_id: "c",
    rate_limit_id: "r",
    limit_value: -1,
    time_unit: "MINUTE",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes(">= 0")));
});

test("limit_value must be an integer", () => {
  const r = validateLimit({
    service_name: "s",
    customer_id: "c",
    rate_limit_id: "r",
    limit_value: 1.5,
    time_unit: "DAY",
  });
  assert.equal(r.ok, false);
});

test("numeric strings are coerced", () => {
  const r = validateLimit({
    service_name: "s",
    customer_id: "c",
    rate_limit_id: "r",
    limit_value: "500",
    time_unit: "DAY",
  });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.limit_value, 500);
});

test("bad time_unit is rejected", () => {
  const r = validateLimit({
    service_name: "s",
    customer_id: "c",
    rate_limit_id: "r",
    limit_value: 5,
    time_unit: "WEEK",
  });
  assert.equal(r.ok, false);
});

test("'*' is a valid customer_id (the default row)", () => {
  const r = validateLimit({
    service_name: "s",
    customer_id: "*",
    rate_limit_id: "r",
    limit_value: 5,
    time_unit: "MONTH",
  });
  assert.ok(r.ok);
});

test("missing fields are reported", () => {
  const r = validateLimit({ service_name: "s" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.length >= 2);
});

test("validateKey requires all three parts", () => {
  assert.equal(validateKey({ service_name: "s", customer_id: "c" }).ok, false);
  assert.ok(validateKey({ service_name: "s", customer_id: "c", rate_limit_id: "r" }).ok);
});

test("validateAmount enforces a positive integer within cap", () => {
  assert.ok(validateAmount(5).ok);
  assert.equal(validateAmount(0).ok, false);
  assert.equal(validateAmount(-3).ok, false);
  assert.equal(validateAmount(1.2).ok, false);
  assert.equal(validateAmount(10, 5).ok, false);
});
