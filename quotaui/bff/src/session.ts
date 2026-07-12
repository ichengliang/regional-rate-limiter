// Server-side sessions + identity resolution (design §4).
//
// The BFF holds the session; the browser only ever gets an opaque HttpOnly cookie
// (§4.1). AuthN is pluggable: production uses OIDC (Authorization Code + PKCE) to
// resolve the human, then this module establishes the BFF's own session (§4.2).
// This build ships a *dev authenticator* (login by user id) standing in for the
// OIDC callback; the session/RBAC/identity→actor core it feeds is the real,
// tested logic. AUTH_MODE=oidc disables the dev login route.
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Grant, User } from "./rbac.js";
import { editableServices } from "./rbac.js";

export const SESSION_COOKIE = "quotaui_sid";
export const CSRF_HEADER = "x-csrf-token";

export interface Session {
  id: string;
  user: User;
  csrfToken: string;
  createdAt: number;
}

// Resolves a subject id → grants. In production these come from IdP groups/claims
// or an internal grant store the `admin` role manages (§4.2). Here it is a simple
// in-memory map, seedable for dev and injectable for tests.
export class GrantStore {
  private users = new Map<string, User>();

  constructor(seed: User[] = []) {
    for (const u of seed) this.users.set(u.id, u);
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  put(user: User): void {
    this.users.set(user.id, user);
  }

  setGrants(id: string, grants: Grant[]): void {
    const u = this.users.get(id);
    if (u) u.grants = grants;
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(user: User): Session {
    const s: Session = {
      id: randomBytes(24).toString("hex"),
      user,
      csrfToken: randomBytes(24).toString("hex"),
      createdAt: Date.now(),
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): Session | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

// Attached to req by attachSession(); routes read req.session.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

export interface AuthDeps {
  sessions: SessionStore;
  grants: GrantStore;
  authMode: "dev" | "oidc";
}

// Reads the session cookie and attaches the live session (if any) to the request.
export function attachSession(deps: AuthDeps) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sid = req.cookies?.[SESSION_COOKIE];
    req.session = deps.sessions.get(sid);
    next();
  };
}

// Gate: 401 unless there is a valid session.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({ error: "not authenticated" });
    return;
  }
  next();
}

// CSRF: state-changing methods must carry the per-session token (§4.2). SameSite=Lax
// on the cookie is the first defense; this is the second.
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const token = req.header(CSRF_HEADER);
    if (!token || token !== req.session?.csrfToken) {
      res.status(403).json({ error: "bad or missing CSRF token" });
      return;
    }
  }
  next();
}

function setSessionCookie(res: Response, session: Session): void {
  res.cookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

// The public view of a session handed to the SPA (no secrets beyond the CSRF
// token, which is meant to be read by the SPA and echoed back).
export function sessionPayload(session: Session) {
  return {
    user: { id: session.user.id, email: session.user.email },
    grants: session.user.grants,
    editable_services: editableServices(session.user),
    csrf_token: session.csrfToken,
  };
}

// Dev login: POST /api/auth/login { user }. Stands in for the OIDC callback that
// would, in production, validate the ID token and map claims → grants (§4.1).
// Disabled when AUTH_MODE=oidc.
export function devLogin(deps: AuthDeps) {
  return (req: Request, res: Response): void => {
    if (deps.authMode === "oidc") {
      res.status(404).json({ error: "dev login disabled (AUTH_MODE=oidc)" });
      return;
    }
    const id = String(req.body?.user ?? "");
    const user = deps.grants.get(id);
    if (!user) {
      res.status(401).json({ error: `unknown user '${id}'` });
      return;
    }
    const session = deps.sessions.create(user);
    setSessionCookie(res, session);
    res.json(sessionPayload(session));
  };
}

export function logout(deps: AuthDeps) {
  return (req: Request, res: Response): void => {
    deps.sessions.destroy(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  };
}
