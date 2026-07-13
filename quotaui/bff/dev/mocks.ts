// In-memory gRPC fakes for quotamgmt.v1.LimitAdmin and quotaenforcer.v1.RateLimiter.
// Shared by the integration tests (test/helpers.ts) and the mock dev server
// (dev/server.ts) so you can click through the whole UI without standing up the
// real Java/Rust backends. NOT shipped in the production build (dev/ is outside
// src/); this is a local convenience only.
import {
  Server,
  ServerCredentials,
  status as GrpcStatus,
  type sendUnaryData,
  type ServerUnaryCall,
} from "@grpc/grpc-js";
import { LimitAdminCtor, RateLimiterCtor } from "../src/grpc.js";
import { objectToStruct } from "../src/struct.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function nowTs() {
  const ms = Date.now();
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
}

function actorOf(call: ServerUnaryCall<any, any>): string {
  const v = call.metadata.get("x-actor");
  return v.length ? String(v[0]) : "";
}

// ---- fake quotamgmt (control plane) ----

interface StoredLimit {
  config_id: number;
  key: { service_name: string; customer_id: string; rate_limit_id: string };
  limit_value: number;
  time_unit: string;
}

export class FakeQuotamgmt {
  limits = new Map<string, StoredLimit>();
  services = new Map<string, { service_name: string; display_name: string; owner: string }>();
  audit: any[] = [];
  private nextConfigId = 1;
  private nextAuditId = 1;

  private k(key: { service_name: string; customer_id: string; rate_limit_id: string }) {
    return `${key.service_name}|${key.customer_id}|${key.rate_limit_id}`;
  }

  private writeAudit(op: string, oldRow: any, newRow: any, actor: string, configId: number) {
    this.audit.push({
      audit_id: this.nextAuditId++,
      config_id: configId,
      operation: op,
      old_row: oldRow,
      new_row: newRow,
      changed_by: actor,
      changed_at: nowTs(),
    });
  }

  impl() {
    const self = this;
    return {
      CreateLimit(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const actor = actorOf(call);
        if (!actor) return cb({ code: GrpcStatus.INVALID_ARGUMENT, details: "app.actor must be set" });
        const { key, limit_value, time_unit } = call.request;
        if (self.limits.has(self.k(key))) {
          return cb({ code: GrpcStatus.ALREADY_EXISTS, details: "limit already exists" });
        }
        const stored: StoredLimit = {
          config_id: self.nextConfigId++,
          key,
          limit_value: Number(limit_value),
          time_unit,
        };
        self.limits.set(self.k(key), stored);
        self.writeAudit("INSERT", null, { ...key, limit_value: stored.limit_value, time_unit }, actor, stored.config_id);
        cb(null, { limit: stored });
      },
      UpdateLimit(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const actor = actorOf(call);
        if (!actor) return cb({ code: GrpcStatus.INVALID_ARGUMENT, details: "app.actor must be set" });
        const { key, limit_value, time_unit, create_if_absent } = call.request;
        const existing = self.limits.get(self.k(key));
        if (!existing) {
          if (!create_if_absent) return cb({ code: GrpcStatus.NOT_FOUND, details: "no such limit" });
          const stored: StoredLimit = { config_id: self.nextConfigId++, key, limit_value: Number(limit_value), time_unit };
          self.limits.set(self.k(key), stored);
          self.writeAudit("INSERT", null, { ...key, limit_value: stored.limit_value, time_unit }, actor, stored.config_id);
          return cb(null, { limit: stored });
        }
        const oldRow = { ...key, limit_value: existing.limit_value, time_unit: existing.time_unit };
        existing.limit_value = Number(limit_value);
        existing.time_unit = time_unit;
        self.writeAudit("UPDATE", oldRow, { ...key, limit_value: existing.limit_value, time_unit }, actor, existing.config_id);
        cb(null, { limit: existing });
      },
      DeleteLimit(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const actor = actorOf(call);
        if (!actor) return cb({ code: GrpcStatus.INVALID_ARGUMENT, details: "app.actor must be set" });
        const { key, allow_missing } = call.request;
        const existing = self.limits.get(self.k(key));
        if (!existing) {
          if (allow_missing) return cb(null, {});
          return cb({ code: GrpcStatus.NOT_FOUND, details: "no such limit" });
        }
        self.limits.delete(self.k(key));
        self.writeAudit("DELETE", { ...key, limit_value: existing.limit_value, time_unit: existing.time_unit }, null, actor, existing.config_id);
        cb(null, {});
      },
      GetLimit(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const { key, resolve } = call.request;
        const exact = self.limits.get(self.k(key));
        if (exact) return cb(null, { limit: exact, is_default: key.customer_id === "*" });
        if (resolve) {
          const def = self.limits.get(self.k({ ...key, customer_id: "*" }));
          if (def) return cb(null, { limit: def, is_default: true });
        }
        cb({ code: GrpcStatus.NOT_FOUND, details: "unconfigured" });
      },
      ListLimits(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const { service_name, customer_id, rate_limit_id } = call.request;
        const limits = [...self.limits.values()].filter(
          (l) =>
            l.key.service_name === service_name &&
            (!customer_id || l.key.customer_id === customer_id) &&
            (!rate_limit_id || l.key.rate_limit_id === rate_limit_id),
        );
        cb(null, { limits, next_page_token: "" });
      },
      RegisterService(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const s = call.request.service;
        self.services.set(s.service_name, s);
        cb(null, { service: s });
      },
      GetService(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const s = self.services.get(call.request.service_name);
        if (!s) return cb({ code: GrpcStatus.NOT_FOUND, details: "no such service" });
        cb(null, { service: s });
      },
      ListServices(_call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        cb(null, { services: [...self.services.values()], next_page_token: "" });
      },
      ListAuditEntries(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const { service_name, key, config_id } = call.request;
        let entries = self.audit.filter((e) => {
          const row = e.new_row ?? e.old_row;
          return row?.service_name === service_name;
        });
        // config_id arrives as an int64 string ("0" when unset — truthy!), so
        // treat only a positive value as a real filter.
        if (config_id && Number(config_id) > 0) {
          entries = entries.filter((e) => e.config_id === Number(config_id));
        }
        if (key?.customer_id && key?.rate_limit_id) {
          entries = entries.filter((e) => {
            const row = e.new_row ?? e.old_row;
            return row?.customer_id === key.customer_id && row?.rate_limit_id === key.rate_limit_id;
          });
        }
        // Encode JSONB rows as google.protobuf.Struct on the wire, like real quotamgmt.
        const wire = entries.map((e) => ({
          ...e,
          old_row: e.old_row ? objectToStruct(e.old_row) : null,
          new_row: e.new_row ? objectToStruct(e.new_row) : null,
        }));
        cb(null, { entries: wire, next_page_token: "" });
      },
    };
  }
}

// ---- fake quotaenforcer (data plane read/op API) ----

export class FakeQuotaenforcer {
  // consumed counter + resolved limit per key (seed via `seed`).
  private state = new Map<string, { consumed: number; limit: number; configured: boolean }>();
  lastRefund?: { actor: string; amount: number; request_id: string };

  private k(key: { service_name: string; customer_id: string; rate_limit_id: string }) {
    return `${key.service_name}|${key.customer_id}|${key.rate_limit_id}`;
  }

  seed(
    key: { service_name: string; customer_id: string; rate_limit_id: string },
    v: { consumed: number; limit: number; configured?: boolean },
  ) {
    this.state.set(this.k(key), { consumed: v.consumed, limit: v.limit, configured: v.configured ?? true });
  }

  get(key: { service_name: string; customer_id: string; rate_limit_id: string }) {
    return this.state.get(this.k(key));
  }

  impl() {
    const self = this;
    return {
      GetUsage(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const key = call.request.key;
        const s = self.state.get(self.k(key)) ?? { consumed: 0, limit: 0, configured: false };
        cb(null, {
          consumed: s.consumed,
          remaining: s.configured ? s.limit - s.consumed : 0,
          limit: s.limit,
          reset_at: nowTs(),
          configured: s.configured,
        });
      },
      Refund(call: ServerUnaryCall<any, any>, cb: sendUnaryData<any>) {
        const { key, amount, request_id } = call.request;
        self.lastRefund = { actor: actorOf(call), amount: Number(amount), request_id };
        const s = self.state.get(self.k(key)) ?? { consumed: 0, limit: 0, configured: false };
        s.consumed = Math.max(0, s.consumed - Number(amount)); // floor at 0 (parent §6.5)
        self.state.set(self.k(key), s);
        cb(null, { remaining: s.limit - s.consumed, limit: s.limit, reset_at: nowTs() });
      },
    };
  }
}

// ---- lifecycle: start both servers ----

export interface Harness {
  mgmt: FakeQuotamgmt;
  enforcer: FakeQuotaenforcer;
  quotamgmtAddr: string;
  quotaenforcerAddr: string;
  servers: Server[];
  close: () => Promise<void>;
}

// ports default to 0 (ephemeral, for tests); pass fixed ports for a dev server.
export async function startBackends(
  ports: { mgmtPort?: number; enforcerPort?: number } = {},
): Promise<Harness> {
  const mgmt = new FakeQuotamgmt();
  const enforcer = new FakeQuotaenforcer();

  const mgmtServer = new Server();
  mgmtServer.addService((LimitAdminCtor as any).service, mgmt.impl());
  const enforcerServer = new Server();
  enforcerServer.addService((RateLimiterCtor as any).service, enforcer.impl());

  const mgmtPort = await bind(mgmtServer, ports.mgmtPort ?? 0);
  const enforcerPort = await bind(enforcerServer, ports.enforcerPort ?? 0);

  return {
    mgmt,
    enforcer,
    quotamgmtAddr: `127.0.0.1:${mgmtPort}`,
    quotaenforcerAddr: `127.0.0.1:${enforcerPort}`,
    servers: [mgmtServer, enforcerServer],
    close: () =>
      Promise.all([shutdown(mgmtServer), shutdown(enforcerServer)]).then(() => undefined),
  };
}

function bind(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(`127.0.0.1:${port}`, ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}
