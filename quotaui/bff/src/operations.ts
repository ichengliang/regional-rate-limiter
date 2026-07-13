// Mutating operation executors. Each performs the real backend call with the
// authenticated actor attached (identity→actor, design §4.4) and records an
// action-log entry (§9.3). Both the direct route and the two-person approval path
// call these, so the applied change is identical either way.
import { randomBytes } from "node:crypto";
import type { Backends } from "./grpc.js";
import type { ActionLog } from "./actionlog.js";
import { actorMetadata, call, timestampToIso, toLimitView, toUsageView } from "./rpc.js";
import type { LimitView, TimeUnit, UsageView } from "./types.js";
import type { PendingOp } from "./reviews.js";

export interface OpContext {
  backends: Backends;
  actionLog: ActionLog;
  actor: string; // the applying identity (initiator for direct, approver for reviewed)
  initiator?: string; // set on the reviewed path
  approver?: string; // set on the reviewed path
}

function key(o: { service_name: string; customer_id: string; rate_limit_id: string }) {
  return {
    service_name: o.service_name,
    customer_id: o.customer_id,
    rate_limit_id: o.rate_limit_id,
  };
}

function reqId(): string {
  return `quotaui-${randomBytes(8).toString("hex")}`;
}

// ---- config (quotamgmt) ----

export async function createLimit(
  ctx: OpContext,
  input: {
    service_name: string;
    customer_id: string;
    rate_limit_id: string;
    limit_value: number;
    time_unit: TimeUnit;
  },
): Promise<LimitView> {
  const res = await call<{ limit: never }>(
    ctx.backends.quotamgmt,
    "CreateLimit",
    {
      key: key(input),
      limit_value: input.limit_value,
      time_unit: input.time_unit,
    },
    actorMetadata(ctx.actor),
  );
  ctx.actionLog.append({
    actor: ctx.actor,
    action: "limit:create",
    target: key(input),
    details: { limit_value: input.limit_value, time_unit: input.time_unit },
    initiator: ctx.initiator,
    approver: ctx.approver,
  });
  return toLimitView(res.limit);
}

export async function updateLimit(
  ctx: OpContext,
  input: {
    service_name: string;
    customer_id: string;
    rate_limit_id: string;
    limit_value: number;
    time_unit: TimeUnit;
    create_if_absent?: boolean;
  },
): Promise<LimitView> {
  const res = await call<{ limit: never }>(
    ctx.backends.quotamgmt,
    "UpdateLimit",
    {
      key: key(input),
      limit_value: input.limit_value,
      time_unit: input.time_unit,
      create_if_absent: input.create_if_absent ?? false,
    },
    actorMetadata(ctx.actor),
  );
  ctx.actionLog.append({
    actor: ctx.actor,
    action: "limit:update",
    target: key(input),
    details: { limit_value: input.limit_value, time_unit: input.time_unit },
    initiator: ctx.initiator,
    approver: ctx.approver,
  });
  return toLimitView(res.limit);
}

export async function deleteLimit(
  ctx: OpContext,
  input: { service_name: string; customer_id: string; rate_limit_id: string; allow_missing?: boolean },
): Promise<void> {
  await call(
    ctx.backends.quotamgmt,
    "DeleteLimit",
    { key: key(input), allow_missing: input.allow_missing ?? false },
    actorMetadata(ctx.actor),
  );
  ctx.actionLog.append({
    actor: ctx.actor,
    action: "limit:delete",
    target: key(input),
    initiator: ctx.initiator,
    approver: ctx.approver,
  });
}

// ---- data plane (quotaenforcer) ----

interface RawRefundRes {
  remaining: string | number;
  limit: string | number;
  reset_at: unknown;
}

export async function refund(
  ctx: OpContext,
  input: { service_name: string; customer_id: string; rate_limit_id: string; amount: number },
): Promise<{ remaining: number; limit: number; reset_at: string | null; request_id: string }> {
  const request_id = reqId();
  const res = await call<RawRefundRes>(
    ctx.backends.quotaenforcer,
    "Refund",
    { key: key(input), amount: input.amount, request_id },
    actorMetadata(ctx.actor),
  );
  ctx.actionLog.append({
    actor: ctx.actor,
    action: "op:refund",
    target: key(input),
    details: { amount: input.amount },
    request_id,
    initiator: ctx.initiator,
    approver: ctx.approver,
  });
  return {
    remaining: Number(res.remaining),
    limit: Number(res.limit),
    reset_at: timestampToIso(res.reset_at),
    request_id,
  };
}

// Reset = refund the current `consumed` (design §2.5 note — no backdoor; reuse
// the same Refund path production trusts, which preserves the window TTL).
export async function resetWindow(
  ctx: OpContext,
  input: { service_name: string; customer_id: string; rate_limit_id: string },
): Promise<UsageView> {
  const fetchedAt = new Date().toISOString();
  const usage = await call<{
    consumed: string | number;
    remaining: string | number;
    limit: string | number;
    reset_at: unknown;
    configured: boolean;
  }>(ctx.backends.quotaenforcer, "GetUsage", { key: key(input) });

  const consumed = Number(usage.consumed);
  const request_id = reqId();
  if (consumed > 0) {
    await call(
      ctx.backends.quotaenforcer,
      "Refund",
      { key: key(input), amount: consumed, request_id },
      actorMetadata(ctx.actor),
    );
  }
  ctx.actionLog.append({
    actor: ctx.actor,
    action: "op:reset",
    target: key(input),
    details: { refunded: Math.max(consumed, 0) },
    request_id,
    initiator: ctx.initiator,
    approver: ctx.approver,
  });

  // Re-read so the UI shows the post-reset state.
  const after = await call<{
    consumed: string | number;
    remaining: string | number;
    limit: string | number;
    reset_at: unknown;
    configured: boolean;
  }>(ctx.backends.quotaenforcer, "GetUsage", { key: key(input) });
  return toUsageView(key(input), after, fetchedAt);
}

// Dispatch a reviewed PendingOp once approved. `ctx.actor` is the approver (the
// applying identity), with initiator/approver captured in the action log (§9.2).
export async function executePendingOp(ctx: OpContext, op: PendingOp): Promise<unknown> {
  switch (op.kind) {
    case "limit:update":
      return updateLimit(ctx, { ...op, time_unit: op.time_unit as TimeUnit, create_if_absent: true });
    case "limit:delete":
      return deleteLimit(ctx, { ...op, allow_missing: false });
    case "op:refund":
      return refund(ctx, op);
    case "op:reset":
      return resetWindow(ctx, op);
    default:
      throw new Error("unknown pending op");
  }
}
