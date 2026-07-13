// Small route helpers: async error funneling, RBAC guard, and OpContext building.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { RpcError } from "../rpc.js";
import { authorize, type Capability } from "../rbac.js";
import type { AppDeps } from "../deps.js";
import type { OpContext } from "../operations.js";

// Wrap an async handler so thrown errors reach the error middleware.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

// Authoritative RBAC check (design §4.3). Returns true if allowed; otherwise
// writes a 403 and returns false so the caller can `return`.
export function guard(
  req: Request,
  res: Response,
  deps: AppDeps,
  cap: Capability,
  service?: string,
): boolean {
  const user = req.session!.user; // requireAuth runs first
  const decision = authorize(user, cap, service, deps.policy);
  if (!decision.ok) {
    res.status(403).json({ error: "forbidden", reason: decision.reason });
    return false;
  }
  return true;
}

export function opContext(req: Request, deps: AppDeps): OpContext {
  return {
    backends: deps.backends,
    actionLog: deps.actionLog,
    actor: req.session!.user.email,
  };
}

// Terminal error middleware — maps RpcError to its HTTP status; anything else 500.
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;
  if (err instanceof RpcError) {
    res.status(err.httpStatus).json({ error: err.message, grpc_code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  res.status(500).json({ error: message });
}
