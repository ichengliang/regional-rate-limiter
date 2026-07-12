import { test } from "node:test";
import assert from "node:assert/strict";
import { windowId } from "../src/util/windowId";

// 2026-07-12 14:04:38 UTC — matches the wireframe example in §6.3.
const d = new Date(Date.UTC(2026, 6, 12, 14, 4, 38));

test("MINUTE window is aligned to YYYYMMDDHHmm (drops seconds)", () => {
  assert.equal(windowId("MINUTE", d), "202607121404");
});

test("DAY window is YYYYMMDD", () => {
  assert.equal(windowId("DAY", d), "20260712");
});

test("MONTH window is YYYYMM", () => {
  assert.equal(windowId("MONTH", d), "202607");
});

test("uses UTC, not local time", () => {
  // A time that is a different day in negative-offset local zones.
  const midnightUtc = new Date(Date.UTC(2026, 0, 1, 0, 30, 0));
  assert.equal(windowId("DAY", midnightUtc), "20260101");
});

test("zero-pads single-digit month/day/hour/minute", () => {
  const early = new Date(Date.UTC(2026, 2, 3, 4, 5, 0));
  assert.equal(windowId("MINUTE", early), "202603030405");
});
