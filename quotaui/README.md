# quotaui — Internal Admin UI

Internal admin console for the Regional Rate Limiting Service. It is a
**control-plane client only** and is never in the request hot path (see
[`design/quotaui.md`](../design/quotaui.md)). If quotaui is completely down,
enforcement is unaffected.

It talks to **quotamgmt** (control plane: config / services / audit) and to
**quotaenforcer**'s read/op API (live usage, refund/reset) — and to nothing else.
It never touches Postgres or Redis directly.

## Layout

- `bff/` — Node + TypeScript + Express **backend-for-frontend**. Holds the
  session, enforces RBAC authoritatively, threads the signed-in human into the
  audit trail (identity → `app.actor` → `changed_by`), and is the only thing that
  talks to the backends. Loads the shared gRPC contracts from `../../proto`
  dynamically via `@grpc/proto-loader` (no codegen).
- `frontend/` — Vite + React + TypeScript **single-page app**. Renders the
  screens, holds no secrets, mirrors RBAC only for UX (hide/disable).

## What's implemented

Per [`design/quotaui.md`](../design/quotaui.md):

| Area | Design | Status |
|------|--------|--------|
| Limits Browser + effective-limit hint | §2.1 | ✅ `GET /api/limits`, `/api/limits/resolve` |
| Limit Editor (create/update/delete, diff preview, delete-confirm) | §2.2 | ✅ `POST/PUT/DELETE /api/limits` |
| Service management | §2.3 | ✅ `GET/POST/PUT /api/services` |
| Live Usage viewer | §2.4 | ✅ `GET /api/usage` |
| Manual ops: refund + window reset (reset = `Refund(consumed)`) | §2.5 | ✅ `POST /api/ops/refund`, `/api/ops/reset` |
| Audit / history browser (field-level diff) | §2.6 | ✅ `GET /api/audit`, `/api/audit/config/:id` |
| SPA + BFF split | §3 | ✅ |
| AuthN (SSO/OIDC-shaped) + session + CSRF | §4.1–4.2 | ✅ dev authenticator; see note below |
| RBAC — authoritative in the BFF, mirrored in the SPA for UX | §1.4, §4.3 | ✅ `viewer` / `service-editor` / `operator` / `admin` |
| Identity → audit `changed_by` (via `x-actor` gRPC metadata) | §4.4 | ✅ |
| Confirmation + diff on writes | §9.1 | ✅ |
| Two-person (maker-checker) review | §9.2 | ✅ default-on for `'*'` defaults, window resets, large refunds |
| Append-only UI action log (captures the initiator/approver pair) | §9.3 | ✅ `GET /api/actionlog` |

### Deviations from the design, and why

These follow from the task constraint "use the quotamgmt and quotaenforcer API
only" — i.e. only what the shared `proto/` contracts actually expose:

- **Observability panels (§2.7 / §5.6) are not built.** The
  `quotaenforcer.v1.RateLimiter` proto has **no metrics RPC**, so there is no API
  to back throttle-rate / fail-open-rate / hot-key panels without inventing a
  contract. The design already says richer observability deep-links out to
  Grafana (§2.7); that link-out is the intended path here.
- **Window reset uses `Refund(consumed)`, not a dedicated RPC.** There is no
  `ResetWindow` RPC in the proto; the design's own §2.5 note prescribes expressing
  a reset as a refund of the current `consumed`, which is what the BFF does
  (read `GetUsage` → `Refund`). No backdoor, same trusted path.
- **Service edit maps to `RegisterService`** (the proto has no `UpdateService`;
  `RegisterService` upserts).
- **Audit `changed_by` / `operation` filters are applied in the BFF**, because
  `ListAuditEntriesRequest` only supports `service_name` / `key` / `config_id` /
  `since`. This traffic is a rounding error against real load (§8.2).
- **Authentication is a dev authenticator standing in for OIDC.** Real OIDC
  (Authorization Code + PKCE) needs a live IdP that can't run/test here, so
  `src/session.ts` ships a pluggable auth layer with a login-by-user-id dev
  provider; the session / RBAC / identity→actor core it feeds is the real, tested
  logic. Set `AUTH_MODE=oidc` to disable the dev login route (the OIDC callback
  would then call `sessions.create(user)` in its place).

## Manual testing

See **[MANUAL_TESTING.md](MANUAL_TESTING.md)** for a full walkthrough, including
prerequisites for both **mock mode** (no external services) and **real-backends
mode** (quotamgmt + Postgres, quotaenforcer + Redis), seeded users/data, and
step-by-step scenarios. Quick start with mock backends:

```bash
cd bff && npm install && npm run dev:mock     # BFF + in-memory fakes on :8080
cd frontend && npm install && npm run dev     # SPA on :5173
```

## Run the BFF

```bash
cd bff
npm install
npm run dev        # Express on http://localhost:8080 (AUTH_MODE=dev)
```

Env: `PORT` (default `8080`), `QUOTAMGMT_ADDR` (default `localhost:50051`),
`QUOTAENFORCER_ADDR` (default `localhost:50052`), `AUTH_MODE` (`dev` | `oidc`),
`PROTO_ROOT` (override the proto tree location).

Dev users seeded for `AUTH_MODE=dev`: `alice` (operator), `bob`
(service-editor of `search-svc`), `vic` (viewer), `admin`.

```bash
curl http://localhost:8080/healthz                              # {"status":"ok"}
curl -c cj -X POST http://localhost:8080/api/auth/login \
  -H 'content-type: application/json' -d '{"user":"alice"}'     # -> session + csrf_token
```

## Run the frontend

```bash
cd frontend
npm install
npm run dev        # SPA on http://localhost:5173 (proxies /api → :8080)
```

## Tests

- **BFF** (`cd bff && npm test`) — unit tests (RBAC decision logic, limit
  validation, review policy) and integration tests that stand up **in-process
  gRPC servers** implementing the quotamgmt / quotaenforcer contracts and drive
  the BFF over real gRPC via `supertest`. Covers: RBAC denials, CSRF,
  identity→actor **audit-correctness** (a write attributes `changed_by` to the
  signed-in human), the 409/404 mappings, live-usage negative-remaining, and the
  full **two-person review** flow (pending → initiator-can't-self-approve →
  second operator applies).
- **Frontend** (`cd frontend && npm test`) — unit tests for the pure-logic utils
  (`windowId` §6.1, audit/editor `diff` §6.2, the RBAC UX mirror).

```bash
cd bff && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test
```
