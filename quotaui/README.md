# quotaui — Internal Admin UI

Internal admin console for the Regional Rate Limiting Service. It is a
**control-plane client only** and is never in the request hot path (see
[`design/quotaui.md`](../design/quotaui.md)).

This directory currently holds a **build scaffold only** — no real screens, auth,
or BFF routes. It exists so the two subprojects install, typecheck, and run.

## Layout

- `bff/` — Node + TypeScript + Express backend-for-frontend. Loads the shared
  gRPC contracts from `../proto` dynamically via `@grpc/proto-loader` (no codegen)
  and constructs clients for `quotamgmt.v1.LimitAdmin` and
  `quotaenforcer.v1.RateLimiter`.
- `frontend/` — Vite + React + TypeScript single-page app.

## Run the BFF

```bash
cd bff
npm install
npm run dev        # starts Express on http://localhost:8080
```

Configurable via env: `PORT` (default `8080`), `QUOTAMGMT_ADDR`,
`QUOTAENFORCER_ADDR`. The only implemented route is the health check:

```bash
curl http://localhost:8080/healthz    # -> {"status":"ok"}
```

## Run the frontend

```bash
cd frontend
npm install
npm run dev        # serves the SPA on http://localhost:5173
```

The dev server proxies `/api` to the BFF on port `8080`.

## Not yet implemented

Real screens (Limits Browser, Editor, Live Usage, Audit, etc.), OIDC auth /
sessions, RBAC enforcement, and the BFF `/api` routes that proxy to quotamgmt and
quotaenforcer are all specified in [`design/quotaui.md`](../design/quotaui.md)
and are **not** built yet.
