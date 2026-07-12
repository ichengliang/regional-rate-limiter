// Promisified unary gRPC calls + gRPC↔HTTP error mapping + actor propagation.
import { Metadata, status as GrpcStatus, type Client } from "@grpc/grpc-js";
import type { ServiceError } from "@grpc/grpc-js";
import type { AuditView, LimitView, ServiceView, TimeUnit, UsageView } from "./types.js";
import { structToObject } from "./struct.js";

// Metadata key carrying the authenticated human identity to the backend. This is
// how the identity→`app.actor`→`changed_by` chain (design §4.4) is threaded: the
// BFF sets it from the *server-side session*, never from a client-supplied field.
export const ACTOR_METADATA_KEY = "x-actor";

export function actorMetadata(actor: string): Metadata {
  const md = new Metadata();
  md.set(ACTOR_METADATA_KEY, actor);
  return md;
}

// An HTTP-mappable error surfaced from a downstream gRPC call.
export class RpcError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function grpcToHttp(code: number | undefined): number {
  switch (code) {
    case GrpcStatus.INVALID_ARGUMENT:
    case GrpcStatus.FAILED_PRECONDITION:
    case GrpcStatus.OUT_OF_RANGE:
      return 400;
    case GrpcStatus.NOT_FOUND:
      return 404;
    case GrpcStatus.ALREADY_EXISTS:
      return 409;
    case GrpcStatus.PERMISSION_DENIED:
      return 403;
    case GrpcStatus.UNAUTHENTICATED:
      return 401;
    case GrpcStatus.UNIMPLEMENTED:
      return 501;
    case GrpcStatus.DEADLINE_EXCEEDED:
    case GrpcStatus.UNAVAILABLE:
      return 503;
    default:
      return 502; // bad gateway — an unexpected backend failure
  }
}

// Wrap one unary method (by name) in a Promise, translating gRPC errors into
// RpcError with an HTTP status. `client` is a dynamic proto-loader client, so the
// method is looked up by string.
export function call<Res = unknown>(
  client: Client,
  method: string,
  request: unknown,
  metadata?: Metadata,
): Promise<Res> {
  const fn = (client as unknown as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    return Promise.reject(new RpcError(500, `no such rpc: ${method}`));
  }
  return new Promise((resolve, reject) => {
    (fn as (...a: unknown[]) => void).call(
      client,
      request,
      metadata ?? new Metadata(),
      (err: ServiceError | null, res: Res) => {
        if (err) {
          reject(new RpcError(grpcToHttp(err.code), err.details || err.message, err.code));
        } else {
          resolve(res);
        }
      },
    );
  });
}

// ---- response normalizers (int64-string → number, Timestamp → ISO) ----

function num(x: unknown): number {
  return x == null ? 0 : Number(x);
}

// google.protobuf.Timestamp decodes to { seconds: string, nanos: number }.
export function timestampToIso(ts: unknown): string | null {
  if (!ts || typeof ts !== "object") return null;
  const t = ts as { seconds?: string | number; nanos?: number };
  if (t.seconds == null) return null;
  const ms = Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6);
  return new Date(ms).toISOString();
}

interface RawLimit {
  key: { service_name: string; customer_id: string; rate_limit_id: string };
  limit_value: string | number;
  time_unit: TimeUnit;
  config_id: string | number;
}

export function toLimitView(l: RawLimit, isDefaultOverride?: boolean): LimitView {
  const customer_id = l.key.customer_id;
  return {
    config_id: l.config_id != null ? num(l.config_id) : null,
    service_name: l.key.service_name,
    customer_id,
    rate_limit_id: l.key.rate_limit_id,
    limit_value: num(l.limit_value),
    time_unit: l.time_unit,
    is_default: isDefaultOverride ?? customer_id === "*",
  };
}

export function toServiceView(s: {
  service_name: string;
  display_name: string;
  owner: string;
}): ServiceView {
  return {
    service_name: s.service_name,
    display_name: s.display_name,
    owner: s.owner,
  };
}

export function toUsageView(
  key: { service_name: string; customer_id: string; rate_limit_id: string },
  u: {
    consumed: string | number;
    remaining: string | number;
    limit: string | number;
    reset_at: unknown;
    configured: boolean;
  },
  fetchedAt: string,
): UsageView {
  return {
    service_name: key.service_name,
    customer_id: key.customer_id,
    rate_limit_id: key.rate_limit_id,
    configured: u.configured,
    limit: u.configured ? num(u.limit) : null,
    consumed: num(u.consumed),
    remaining: num(u.remaining),
    reset_at: timestampToIso(u.reset_at),
    fetched_at: fetchedAt,
  };
}

// old_row/new_row arrive as google.protobuf.Struct wire form; decode to plain JS.
export function toAuditView(e: {
  audit_id: string | number;
  config_id: string | number;
  operation: string;
  old_row: unknown;
  new_row: unknown;
  changed_by: string;
  changed_at: unknown;
}): AuditView {
  return {
    audit_id: num(e.audit_id),
    config_id: num(e.config_id),
    operation: e.operation,
    old_row: structToObject(e.old_row),
    new_row: structToObject(e.new_row),
    changed_by: e.changed_by,
    changed_at: timestampToIso(e.changed_at),
  };
}
