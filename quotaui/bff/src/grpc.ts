// gRPC client factory for the two backends the BFF fronts (design/quotaui.md §5).
// Protos are loaded dynamically from the shared proto tree — no codegen step.
//
// The BFF is the *only* thing that talks to quotamgmt / quotaenforcer (parent
// §5.1). It never touches Postgres or Redis directly.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  credentials,
  loadPackageDefinition,
  type ChannelCredentials,
  type GrpcObject,
  type ServiceClientConstructor,
  type Client,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ (or dist/) → up to quotaui/bff → up to quotaui → up to repo root → proto/.
const PROTO_ROOT = process.env.PROTO_ROOT ?? resolve(__dirname, "../../../proto");

// keepCase so message fields stay snake_case (matching the proto and the JSON we
// return to the SPA); enums as strings ("MINUTE"); int64 as strings (longs).
const loaderOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
};

function loadCtor(protoFile: string, servicePath: string): ServiceClientConstructor {
  const pkgDef = loadSync(resolve(PROTO_ROOT, protoFile), loaderOptions);
  const grpcObj = loadPackageDefinition(pkgDef) as GrpcObject;
  const ctor = servicePath
    .split(".")
    .reduce<unknown>((obj, part) => (obj as Record<string, unknown>)[part], grpcObj);
  if (typeof ctor !== "function") {
    throw new Error(`service ${servicePath} not found in ${protoFile}`);
  }
  return ctor as ServiceClientConstructor;
}

// Exported so tests can stand up in-process gRPC servers with the same contract
// (`server.addService(LimitAdminCtor.service, impl)`).
export const LimitAdminCtor = loadCtor(
  "quotamgmt/v1/limit_admin.proto",
  "quotamgmt.v1.LimitAdmin",
);
export const RateLimiterCtor = loadCtor(
  "quotaenforcer/v1/rate_limiter.proto",
  "quotaenforcer.v1.RateLimiter",
);

// A backend is a raw grpc-js client; the `call()` helper in rpc.ts wraps each
// unary method in a Promise and attaches actor metadata.
export interface Backends {
  quotamgmt: Client;
  quotaenforcer: Client;
}

export interface BackendAddrs {
  quotamgmtAddr?: string;
  quotaenforcerAddr?: string;
  creds?: ChannelCredentials;
}

// TODO(prod): replace createInsecure() with mTLS service identity (design §7,
// parent §16). The BFF authenticates to the backends with its own service
// identity; the human actor is propagated as metadata (see rpc.ts).
export function createBackends(addrs: BackendAddrs = {}): Backends {
  const creds = addrs.creds ?? credentials.createInsecure();
  const quotamgmtAddr =
    addrs.quotamgmtAddr ?? process.env.QUOTAMGMT_ADDR ?? "localhost:50051";
  const quotaenforcerAddr =
    addrs.quotaenforcerAddr ?? process.env.QUOTAENFORCER_ADDR ?? "localhost:50052";
  return {
    quotamgmt: new LimitAdminCtor(quotamgmtAddr, creds),
    quotaenforcer: new RateLimiterCtor(quotaenforcerAddr, creds),
  };
}
