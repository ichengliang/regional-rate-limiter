import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows } from "../src/util/diff";

test("flags only the changed field (§6.2 preview)", () => {
  const d = diffRows(
    { limit_value: 500, time_unit: "MINUTE" },
    { limit_value: 1000, time_unit: "MINUTE" },
  );
  const byField = Object.fromEntries(d.map((f) => [f.field, f]));
  assert.equal(byField.limit_value.changed, true);
  assert.equal(byField.limit_value.before, 500);
  assert.equal(byField.limit_value.after, 1000);
  assert.equal(byField.time_unit.changed, false);
});

test("INSERT (no old_row) shows every field as added", () => {
  const d = diffRows(null, { limit_value: 1000, time_unit: "MINUTE" });
  assert.ok(d.every((f) => f.changed));
  assert.equal(d.length, 2);
});

test("DELETE (no new_row) shows every field as removed", () => {
  const d = diffRows({ limit_value: 5, time_unit: "DAY" }, null);
  assert.ok(d.every((f) => f.changed));
});

test("keys are unioned and sorted", () => {
  const d = diffRows({ b: 1 }, { a: 2 });
  assert.deepEqual(d.map((f) => f.field), ["a", "b"]);
});
