// Assembles the BFF Express app from an injected dependency bundle. Kept separate
// from index.ts so integration tests can build an app against in-process gRPC
// backends without binding a port.
import express from "express";
import cookieParser from "cookie-parser";
import type { AppDeps } from "./deps.js";
import {
  attachSession,
  devLogin,
  logout,
  requireAuth,
  requireCsrf,
  sessionPayload,
} from "./session.js";
import { limitsRouter } from "./routes/limits.js";
import { servicesRouter } from "./routes/services.js";
import { auditRouter } from "./routes/audit.js";
import { usageRouter } from "./routes/usage.js";
import { opsRouter } from "./routes/ops.js";
import { reviewsRouter } from "./routes/reviews.js";
import { errorMiddleware, guard } from "./routes/util.js";

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Health check — used by liveness probes; never touches the backends.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  const authDeps = { sessions: deps.sessions, grants: deps.grants, authMode: deps.authMode };
  app.use(attachSession(authDeps));

  // Auth (unauthenticated entry points). devLogin stands in for the OIDC callback.
  app.post("/api/auth/login", devLogin(authDeps));
  app.post("/api/auth/logout", logout(authDeps));

  // Everything under /api (except the auth endpoints above) requires a session
  // and, for mutations, a CSRF token.
  const api = express.Router();
  api.use(requireAuth);
  api.use(requireCsrf);

  // Who am I / what can I do — drives the SPA's RBAC-aware UX (§4.3).
  api.get("/session", (req, res) => {
    res.json(sessionPayload(req.session!));
  });

  api.use("/limits", limitsRouter(deps));
  api.use("/services", servicesRouter(deps));
  api.use("/audit", auditRouter(deps));
  api.use("/usage", usageRouter(deps));
  api.use("/ops", opsRouter(deps));
  api.use("/reviews", reviewsRouter(deps));

  // Read the UI action log (§9.3) — operator/admin only; captures the two-person
  // pair and the data-plane ops that don't land in Postgres audit.
  api.get("/actionlog", (req, res) => {
    if (!guard(req, res, deps, "review:approve")) return;
    res.json({ entries: deps.actionLog.list({ limit: 200 }) });
  });

  app.use("/api", api);

  // Serve the built SPA when SPA_DIR is set (container/prod: the BFF is the single
  // quotaui service, so it also hosts the compiled frontend). Unset in dev/tests,
  // where Vite serves the SPA and proxies /api here — so this stays a no-op there.
  const spaDir = process.env.SPA_DIR;
  if (spaDir) {
    app.use(express.static(spaDir));
    // Client-side routing fallback: any non-/api GET returns index.html.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile("index.html", { root: spaDir });
    });
  }

  app.use(errorMiddleware);
  return app;
}
