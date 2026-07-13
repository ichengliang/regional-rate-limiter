// Limit-write validation (design §2.2). Mirrors the Postgres constraints
// (schema/postgres.sql: `CHECK (limit_value >= 0)`, `time_unit` enum,
// `uq_limit`). Authority still lives in quotamgmt/Postgres; this is the fast,
// friendly first line and is unit-tested.
import type { TimeUnit } from "./types.js";

export const TIME_UNITS: TimeUnit[] = ["MINUTE", "DAY", "MONTH"];

export interface LimitInput {
  service_name?: unknown;
  customer_id?: unknown;
  rate_limit_id?: unknown;
  limit_value?: unknown;
  time_unit?: unknown;
}

export interface ValidatedLimit {
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
  limit_value: number;
  time_unit: TimeUnit;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

// Validate a full limit body (create / update). Returns either the cleaned value
// or the list of human-readable errors.
export function validateLimit(
  body: LimitInput,
): { ok: true; value: ValidatedLimit } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(body.service_name)) errors.push("service_name is required");
  if (!isNonEmptyString(body.customer_id)) {
    errors.push("customer_id is required ('*' for the default)");
  }
  if (!isNonEmptyString(body.rate_limit_id)) errors.push("rate_limit_id is required");

  const lv = body.limit_value;
  const limitValue = typeof lv === "string" && lv.trim() !== "" ? Number(lv) : lv;
  if (typeof limitValue !== "number" || !Number.isFinite(limitValue)) {
    errors.push("limit_value must be a number");
  } else if (!Number.isInteger(limitValue)) {
    errors.push("limit_value must be an integer");
  } else if (limitValue < 0) {
    errors.push("limit_value must be >= 0"); // mirrors CHECK (limit_value >= 0)
  }

  if (!TIME_UNITS.includes(body.time_unit as TimeUnit)) {
    errors.push(`time_unit must be one of ${TIME_UNITS.join(", ")}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      service_name: body.service_name as string,
      customer_id: body.customer_id as string,
      rate_limit_id: body.rate_limit_id as string,
      limit_value: limitValue as number,
      time_unit: body.time_unit as TimeUnit,
    },
  };
}

export interface KeyInput {
  service_name?: unknown;
  customer_id?: unknown;
  rate_limit_id?: unknown;
}

export function validateKey(
  body: KeyInput,
): { ok: true; value: { service_name: string; customer_id: string; rate_limit_id: string } } | {
  ok: false;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isNonEmptyString(body.service_name)) errors.push("service_name is required");
  if (!isNonEmptyString(body.customer_id)) errors.push("customer_id is required");
  if (!isNonEmptyString(body.rate_limit_id)) errors.push("rate_limit_id is required");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      service_name: body.service_name as string,
      customer_id: body.customer_id as string,
      rate_limit_id: body.rate_limit_id as string,
    },
  };
}

// A positive integer amount for refund (design §2.5). `cap` bounds a single
// manual op (parent §16 input validation).
export function validateAmount(
  raw: unknown,
  cap = 1_000_000_000,
): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "amount must be an integer" };
  }
  if (n <= 0) return { ok: false, error: "amount must be > 0" };
  if (n > cap) return { ok: false, error: `amount exceeds cap (${cap})` };
  return { ok: true, value: n };
}
