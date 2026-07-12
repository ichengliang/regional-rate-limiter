// gRPC client stubs for the two backends the BFF fronts (design/quotaui.md §5).
// Protos are loaded dynamically from the shared ../../proto tree — no codegen step.
// These clients are created but NOT yet wired to any HTTP route (scaffold only).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import type { GrpcObject, ServiceClientConstructor } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_ROOT = resolve(__dirname, "../../../proto");

const loaderOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
};

function loadService(protoFile: string, servicePath: string): ServiceClientConstructor {
  const pkgDef = loadSync(resolve(PROTO_ROOT, protoFile), loaderOptions);
  const grpcObj = loadPackageDefinition(pkgDef) as GrpcObject;
  // Walk the dotted package.Service path (e.g. "quotamgmt.v1.LimitAdmin").
  const ctor = servicePath
    .split(".")
    .reduce<unknown>((obj, part) => (obj as Record<string, unknown>)[part], grpcObj);
  return ctor as ServiceClientConstructor;
}

const LimitAdmin = loadService("quotamgmt/v1/limit_admin.proto", "quotamgmt.v1.LimitAdmin");
const RateLimiter = loadService("quotaenforcer/v1/rate_limiter.proto", "quotaenforcer.v1.RateLimiter");

// TODO: replace credentials.createInsecure() with mTLS service identity (design §7, parent §16),
// and read the target addresses from config.
const QUOTAMGMT_ADDR = process.env.QUOTAMGMT_ADDR ?? "localhost:50051";
const QUOTAENFORCER_ADDR = process.env.QUOTAENFORCER_ADDR ?? "localhost:50052";

// Control plane: config, services, audit (design §5.1, §5.4, §5.5).
export const quotamgmtClient = new LimitAdmin(QUOTAMGMT_ADDR, credentials.createInsecure());
// Data plane read/op API: live usage, refund/reset (design §5.2, §5.3).
export const quotaenforcerClient = new RateLimiter(QUOTAENFORCER_ADDR, credentials.createInsecure());
