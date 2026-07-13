// Integration-test scaffolding. The in-memory gRPC fakes live in dev/mocks.ts
// (shared with the mock dev server); this file adds the supertest wiring.
import request from "supertest";
import type { Express } from "express";
import { createBackends } from "../src/grpc.js";
import { makeDeps } from "../src/deps.js";
import { GrantStore, SessionStore } from "../src/session.js";
import { createApp } from "../src/app.js";
import type { User } from "../src/rbac.js";
import { startBackends, type Harness } from "../dev/mocks.js";

export { FakeQuotamgmt, FakeQuotaenforcer, startBackends } from "../dev/mocks.js";
export type { Harness } from "../dev/mocks.js";

// Build a BFF app wired to the harness, seeded with the standard dev users.
export function buildApp(h: Harness, users: User[], opts: { authMode?: "dev" | "oidc" } = {}) {
  const deps = makeDeps({
    backends: createBackends({ quotamgmtAddr: h.quotamgmtAddr, quotaenforcerAddr: h.quotaenforcerAddr }),
    grants: new GrantStore(users),
    sessions: new SessionStore(),
    authMode: opts.authMode ?? "dev",
  });
  return { app: createApp(deps), deps };
}

// Log a dev user in and return a cookie-persisting supertest agent plus the CSRF
// token to echo on mutating requests.
export async function login(app: Express, user: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ user });
  if (res.status !== 200) throw new Error(`login failed for ${user}: ${res.status} ${res.text}`);
  return { agent, csrf: res.body.csrf_token as string };
}

export const USERS: User[] = [
  { id: "alice", email: "alice@anthropic.com", grants: [{ role: "operator" }] },
  { id: "carol", email: "carol@anthropic.com", grants: [{ role: "operator" }] },
  { id: "bob", email: "bob@anthropic.com", grants: [{ role: "service-editor", service: "search-svc" }] },
  { id: "vic", email: "vic@anthropic.com", grants: [{ role: "viewer" }] },
  { id: "admin", email: "admin@anthropic.com", grants: [{ role: "admin" }] },
];
