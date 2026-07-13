// Append-only log of UI-initiated actions (design §9.3).
//
// Config changes are the system-of-record'd in `limit_config_audit` via quotamgmt
// (§4.4). Data-plane manual ops (refund/reset) do NOT touch Postgres, so quotaui
// keeps its own log so nothing a human does is unattributable. We also log config
// mutations here to capture the two-person initiator/approver pair, which the
// Postgres audit row can't hold.
//
// In production this is a durable store; here it is in-memory (bounded) and
// injectable for tests. §10.1 flags that a downstream success whose action-log
// write fails must alert — callers should treat a log failure as significant.

export interface ActionLogEntry {
  seq: number;
  at: string; // ISO-8601 UTC
  actor: string; // the applying identity
  action: string; // e.g. "limit:update", "op:refund", "op:reset"
  target: Record<string, unknown>;
  details?: Record<string, unknown>;
  request_id?: string; // correlates data-plane ops to quotaenforcer logs (parent §7.2)
  initiator?: string; // two-person maker (§9.2)
  approver?: string; // two-person checker (§9.2)
}

export class ActionLog {
  private entries: ActionLogEntry[] = [];
  private seq = 0;

  append(e: Omit<ActionLogEntry, "seq" | "at">): ActionLogEntry {
    const entry: ActionLogEntry = { ...e, seq: ++this.seq, at: new Date().toISOString() };
    this.entries.push(entry);
    return entry;
  }

  // Newest first, optionally filtered by actor.
  list(opts: { actor?: string; limit?: number } = {}): ActionLogEntry[] {
    let out = [...this.entries].reverse();
    if (opts.actor) out = out.filter((e) => e.actor === opts.actor);
    if (opts.limit != null) out = out.slice(0, opts.limit);
    return out;
  }
}
