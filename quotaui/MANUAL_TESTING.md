# quotaui — Manual Testing Guide

How to run `quotaui` by hand and click through it. There are **two ways** to run
it:

- **Mock mode** (recommended for UI testing) — the BFF runs against in-memory
  fakes of quotamgmt and quotaenforcer. **No Postgres, no Redis, no Java, no Rust.**
- **Real-backends mode** — the BFF talks to the actual quotamgmt and
  quotaenforcer services, which in turn need Postgres and Redis.

`quotaui` itself is a **control-plane client only** and is never in the request
hot path — so its own dependencies are just the two backends it calls (design
`design/quotaui.md` §1, §8.1).

---

## Prerequisites

### Always required

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20.6 | BFF + frontend; uses `node --import tsx` and `--test`. |
| npm | ≥ 9 | Package manager (as specified for this component). |

Install dependencies once:

```bash
cd quotaui/bff && npm install
cd ../frontend && npm install
```

### Mock mode

**Nothing else.** The mock dev server (`bff/dev/server.ts`) starts in-memory gRPC
servers implementing the `quotamgmt.v1.LimitAdmin` and
`quotaenforcer.v1.RateLimiter` contracts and seeds sample data. This is the same
fake used by the integration tests.

### Real-backends mode (only if you want to test against live services)

`quotaui`'s BFF needs these two services reachable over gRPC:

| Service | Default address | Backs it | External dependency |
|---------|-----------------|----------|---------------------|
| **quotamgmt** (control plane, Java) | `localhost:50051` | config / services / audit | **Postgres** (loaded with `schema/postgres.sql`) |
| **quotaenforcer** (data plane, Rust) | `localhost:50052` | live usage, refund/reset | **Redis** (scripts in `schema/redis_scripts.lua`) |

So the full real stack is:

```
quotaui SPA ─▶ quotaui BFF ─┬─▶ quotamgmt ─▶ Postgres   (config + audit)
                            └─▶ quotaenforcer ─▶ Redis   (live counters)
```

Concretely you would need:

- **Postgres** (≥ 14 suggested) with the DDL from `schema/postgres.sql` applied
  (creates `service`, `limit_config`, `limit_config_audit`, and the
  `SET LOCAL app.actor` audit trigger).
- **Redis** (≥ 6, or a Redis-compatible engine) for quotaenforcer's counters.
- **quotamgmt** running and pointed at that Postgres (see `quotamgmt/README.md`;
  Java + Gradle).
- **quotaenforcer** running and pointed at that Redis (see
  `quotaenforcer/README.md`; Rust + Cargo).
- The shared protos in `proto/` (already in the repo; the BFF loads them
  dynamically — no codegen).

> Authentication note: this build ships a **dev authenticator** standing in for
> SSO/OIDC (design §4.1). No IdP is required in either mode. Set `AUTH_MODE=oidc`
> to disable the dev login route (you'd then wire the real OIDC callback).

---

## Run it — Mock mode (recommended)

Two terminals.

**Terminal 1 — BFF with mock backends:**

```bash
cd quotaui/bff
npm run dev:mock
# → quotaui BFF (MOCK backends) → http://localhost:8080
```

**Terminal 2 — frontend:**

```bash
cd quotaui/frontend
npm run dev
# → http://localhost:5173   (proxies /api → http://localhost:8080)
```

Open **http://localhost:5173**.

Environment overrides (optional): `PORT` (BFF port, default `8080`).

---

## Run it — Real-backends mode

Start Postgres + Redis + quotamgmt + quotaenforcer first (see their READMEs),
then:

**Terminal 1 — BFF against the real services:**

```bash
cd quotaui/bff
QUOTAMGMT_ADDR=localhost:50051 \
QUOTAENFORCER_ADDR=localhost:50052 \
npm run dev
```

**Terminal 2 — frontend:** same as above (`npm run dev`).

BFF environment variables:

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8080` | BFF listen port |
| `QUOTAMGMT_ADDR` | `localhost:50051` | quotamgmt gRPC address |
| `QUOTAENFORCER_ADDR` | `localhost:50052` | quotaenforcer gRPC address |
| `AUTH_MODE` | `dev` | `dev` enables login-by-user-id; `oidc` disables it |
| `PROTO_ROOT` | `../../proto` (resolved) | override the proto tree location |

> In real mode the BFF connects lazily, so it starts even if a backend is down;
> calls to a missing backend return `503`/`502`. Config editing still works if
> only quotaenforcer (live usage) is down, and vice-versa (design §8.1).

---

## Sign in

The login screen takes a **user id** (dev auth). Seeded users:

| User id | Role | Scope | Can do |
|---------|------|-------|--------|
| `alice` | operator | global | Everything: edit any service, refund, reset, approve reviews |
| `carol` | operator | global | Second approver for two-person reviews |
| `bob` | service-editor | `search-svc` | Edit only `search-svc` limits; **no** refund/reset |
| `vic` | viewer | global read | Read-only everywhere |
| `admin` | admin | global | Operator + RBAC management |

(These are seeded only in **mock mode** and in the default `npm run dev`. In real
mode the same seed applies unless `AUTH_MODE=oidc`.)

---

## Seeded sample data (mock mode)

- **Services:** `search-svc`, `payments-svc`
- **Limits** (search `search-svc` in the Limits tab):
  - `*` / `default` → 500 / MINUTE  (the default)
  - `cust_42` / `default` → 1000 / MINUTE  (an override)
  - `*` / `export` → 5 / DAY
  - `cust_99` / `export` → 10 / DAY
  - (`payments-svc`) `*` / `charge` → 100 / MINUTE
- **Live counters:**
  - `search-svc` / `cust_42` / `default` → consumed **1003**, limit 1000
    (**remaining −3**, over-quota badge)
  - `search-svc` / `cust_99` / `export` → consumed 3, limit 10

---

## Test scenarios

### 1. Read views (any user, e.g. `vic`)
1. **Limits** tab → Service `search-svc` → **Search**. See the default vs override
   rows with **DEFAULT / OVERRIDE** badges.
2. Set Customer `cust_99`, RL id `export` → the **effective-limit hint** shows it
   falls back to the `*` default (5/DAY).
3. Set Customer `cust_99`, RL id `nope` → hint shows
   *"unconfigured → allow (fail-open, parent §9)"*.
4. **Live Usage** → `search-svc` / `cust_42` / `default` → **Lookup**. Confirm
   **remaining −3** with the "⚠ over quota (bounded overshoot §6.4)" badge.
5. **Audit** → Service `search-svc` → **Search** → expand a row's **diff**.

### 2. RBAC (UX + authoritative)
1. As `vic` (viewer): no **Edit** / **+ New limit** buttons; no refund/reset.
2. As `bob` (search-svc editor): can edit `search-svc`, but searching
   `payments-svc` shows read-only rows (no Edit). Live Usage shows no
   refund/reset buttons.
3. The frontend gating is UX only — the BFF re-checks every request (a forced
   `viewer` write returns `403`; verified by the integration tests).

### 3. Create / edit a limit with diff + audit (as `alice` or `bob`)
1. **Limits** → `+ New limit` → fill service/customer/rl id/limit/unit → note the
   **before → after preview** → **Create**.
2. **Edit** an existing non-default limit → change the value → the preview shows
   only the changed field → **Save change**.
3. **Audit** tab → the change appears with `changed_by` = your signed-in email
   (identity → `app.actor` → `changed_by`, design §4.4).

### 4. Delete confirmation (as `alice`)
1. Edit a non-default limit → in the delete box, **type the exact
   `service/customer/rl id` tuple** to enable the Delete button → Delete.

### 5. Two-person review — window reset (needs `alice` **and** `carol`)
1. As `alice`: **Live Usage** → `search-svc` / `cust_42` / `default` → **Lookup**
   → **Reset window…** → confirm. You get *"Reset requires two-person review"* —
   it is **not** applied (consumed still 1003).
2. Still as `alice`: open **Reviews** tab → try **Approve** → **rejected (403)**:
   the initiator may not approve their own change.
3. Sign out → sign in as `carol` → **Reviews** → **Approve & apply**. Re-check
   Live Usage → consumed is now **0** (reset applied as a `Refund(consumed)`).

### 6. Two-person review — editing a `*` default (as `alice` + `carol`)
1. As `alice`: **Limits** → search `search-svc`, `defaults only` → **Edit** the
   `*` / `default` row → change the value → **Save change** → *pending review*.
2. As `carol`: **Reviews** → **Approve & apply**. The default updates; the audit
   row attributes `changed_by` to `carol` (the applying identity, design §9.2).

### 7. Manual refund (as `alice`)
1. **Live Usage** → `search-svc` / `cust_99` / `export` → **Lookup**
   (consumed 3) → **Refund…** → enter `2` → the counter drops (small refunds
   apply immediately; large refunds > 100000 would enter review).

### 8. Service management (as `alice`)
1. **Services** tab → **Register a service** (new `service_name`) → Register.
2. **Edit** an existing service's display name / owner (the `service_name` is
   immutable).

---

## Teardown

```bash
pkill -f dev/server.ts     # mock BFF   (or the terminal running npm run dev)
pkill -f vite              # frontend
```

Mock-mode state is in-memory: restarting the BFF resets seeded data **and** logs
everyone out (sessions are in-memory too).

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Login returns `401 unknown user` | Use a seeded id (`alice`/`bob`/`vic`/`admin`/`carol`), or `AUTH_MODE=oidc` is set (dev login disabled). |
| Mutations return `403 bad or missing CSRF token` | The SPA sends the token automatically; if calling the API by hand, read `csrf_token` from `GET /api/session` and send it as `x-csrf-token`. |
| Live Usage says "temporarily unavailable" / `502`/`503` (real mode) | quotaenforcer (or its Redis) is down. Config editing still works. |
| Limits/Audit fail (real mode) | quotamgmt (or its Postgres) is down. |
| `/api/*` 404 from the frontend | The Vite dev proxy expects the BFF on `:8080`; start the BFF first or set `PORT` consistently. |
| Observability panels missing | By design — the quotaenforcer proto exposes no metrics RPC; richer observability deep-links to Grafana (design §2.7, and README "Deviations"). |

---

## Automated tests (for reference)

```bash
cd quotaui/bff && npm run typecheck && npm test        # unit + gRPC integration
cd quotaui/frontend && npm run typecheck && npm test   # pure-logic unit tests
```
