# Detailed Design: quotaui — Internal Admin UI

**Status:** Draft
**Author:** chengliangzhang@gmail.com
**Date:** 2026-07-12
**Parent:** `regional-rate-limiter-design.md` §5.1 (Internal Admin UI)
**Siblings:** `design/quotamgmt.md` (control plane), `design/quotaenforcer.md` (data plane)

---

## 1. Overview

`quotaui` is the internal web console for the Regional Rate Limiting Service. It
is the human interface to the control plane described in the high-level design
(`regional-rate-limiter-design.md` §5, §5.1): the place where platform operators
and service owners inspect and edit rate-limit configuration, look at live usage,
run manual remediation, and read the audit trail.

This document is the detailed ("next level") design of that component. It honors
every decision already locked in the parent doc and does not re-open them.

The single most important property of `quotaui`, restated from §5.1, is that it
is a **control-plane client only**. It is **never** in the request hot path. Every
byte it moves is low-QPS, human-initiated config or read traffic. If `quotaui` is
completely down, `quotaenforcer` keeps enforcing quotas and producers keep
serving traffic with **zero** degradation — the check/charge/refund path never
touches this component. This is the same guarantee the parent doc makes in §5.1
("if the UI is down, enforcement is completely unaffected") and it shapes every
non-functional decision below (§8).

### 1.1 Component naming

The parent doc names three components; this doc uses those names throughout:

| Component | Role | This doc |
|-----------|------|----------|
| **quotamgmt** | Control plane — audited CRUD over `limit_config`, `service`, `limit_config_audit`; owns Postgres. Parent doc's "Control-Plane API". | Called by the BFF for all config/audit/service operations. |
| **quotaenforcer** | Data plane — `check`/`charge`/`refund` plus a read API fronting Redis. Parent doc's "RL Service". | Called by the BFF (read API only) for live usage. |
| **quotaui** | Internal Admin UI. | **This document.** |

`quotaui` talks to **quotamgmt** for everything durable (config, services,
audit) and to **quotaenforcer's read API** for live usage. It never talks to
Postgres or Redis directly — there is no backdoor (parent §5.1).

### 1.2 Goals

- A single console where operators and service owners can find, understand, and
  safely change a customer's rate limits without a CLI or a SQL prompt.
- Make **every** change attributable in `limit_config_audit` (Appendix B.1) with
  the correct human `changed_by`, via the existing `SET LOCAL app.actor` path.
- Surface live usage and the throttle/fail-open signals (§15 of the parent doc)
  next to the config that produced them, so "why is this customer throttled?" is
  answerable in one screen.
- Make destructive and remediation actions safe: confirmation, diff preview, and
  optional two-person review, all fully audited.
- Stay entirely out of the hot path and cost almost nothing to run.

### 1.3 Non-Goals

- **Not in the hot path.** `quotaui` never performs or influences a
  check/charge/refund at request time. Its availability, latency, and
  correctness have no bearing on enforcement (parent §5.1).
- **Not a billing/metering tool.** Consistent with the parent doc's non-goal
  (§1.2), we display quota (consumed/remaining), never money. We do not compute
  invoices, price usage, or reconcile spend. Producers may feed our numbers into
  billing elsewhere; that is out of scope.
- **Not an authorization service for producers.** `quotaui` governs who may
  *administer* limits (its own RBAC, §1.4). It does not decide whether an
  end-consumer request is allowed — that is `quotaenforcer`'s quota answer plus
  the producer's own authz.
- **Not a new source of truth.** `quotaui` stores no config of its own. Postgres
  (via quotamgmt) remains the source of truth for config/audit; Redis (via
  quotaenforcer) remains the source of truth for live counters (parent
  Appendix B).
- **Not a general BI / analytics platform.** It surfaces a focused set of
  operational signals and links out to the real dashboards (§2.7).

### 1.4 Users, personas & RBAC roles

Two populations use `quotaui`, matching the parent doc (§5.1):

- **Platform operators** — the team that runs the limiter: on-call, support,
  SRE. They need cross-service visibility and remediation powers (unblock a
  mistakenly throttled customer, reset a window, issue a credit).
- **Service owners** — producers who set their own customers' limits. They are
  scoped to the `service_name`(s) they own and must not see or touch other
  services' config.

RBAC scopes who may edit which service's limits (parent §5.1, tied to the
multi-tenant authz in parent §16). We define four roles. Scope is **per
`service_name`** for the editor role and **global** for operator/admin; a single
user may hold different roles on different services (e.g. `service-editor` on
`search-svc`, `viewer` everywhere).

| Role | Who | Scope | Intent |
|------|-----|-------|--------|
| `viewer` | Anyone with SSO + a business reason | Per-service (or global read) | Read-only: browse limits, live usage, audit, dashboards. |
| `service-editor` | Service owners | Their `service_name`(s) | CRUD limits (incl. `'*'` defaults) and register/manage their own service. |
| `operator` | Platform on-call / support | Global | Everything `service-editor` can do on **any** service, plus manual remediation (refund/credit, window reset). |
| `admin` | Platform team leads | Global | Everything `operator` can do, plus manage `quotaui` RBAC grants and approve high-blast-radius two-person reviews. |

**Permissions matrix** (rows = capability, columns = role; ✔ = allowed, ✔ᔆ =
allowed only within the user's scoped `service_name`(s), — = denied):

| Capability | viewer | service-editor | operator | admin |
|---|:--:|:--:|:--:|:--:|
| Browse limits / defaults | ✔ | ✔ | ✔ | ✔ |
| View live usage (quotaenforcer read) | ✔ | ✔ | ✔ | ✔ |
| Browse audit / history | ✔ | ✔ᔆ | ✔ | ✔ |
| View observability panels | ✔ | ✔ | ✔ | ✔ |
| Create / update a limit | — | ✔ᔆ | ✔ | ✔ |
| Create / update a `'*'` default | — | ✔ᔆ | ✔ | ✔ |
| Delete a limit | — | ✔ᔆ | ✔ | ✔ |
| Register / edit a service | — | ✔ᔆ¹ | ✔ | ✔ |
| Issue refund / credit (manual op) | — | — | ✔ | ✔ |
| Reset a customer's window | — | — | ✔ | ✔ |
| Approve a two-person review | — | —² | ✔ | ✔ |
| Manage RBAC grants | — | — | — | ✔ |

¹ A `service-editor` may edit the services they already own; creating a brand-new
`service_name` may be gated to `operator`/`admin` to prevent namespace grabs
(config knob, §2.3). ² A `service-editor` may **initiate** a change that requires
review but may not approve their own; the second party must be a different
`operator`/`admin` (§9.2).

The matrix is enforced **twice** — in the frontend for UX (hide/disable what you
can't do) and, authoritatively, in the BFF (§4.3). The frontend copy is never
trusted.

---

## 2. Feature / Page Inventory

Seven surfaces. Each maps to concrete quotamgmt / quotaenforcer endpoints (§5)
and, where it mutates, to the audited `SET LOCAL app.actor` write path
(Appendix B.1 of the parent doc).

### 2.1 Limits Browser (read)

The default landing page. A searchable, filterable table of `limit_config` rows.

- **Filters:** `service_name` (dropdown, scoped to what the user may see),
  `customer_id` (free text, incl. `'*'`), `rate_limit_id`, and a
  **default-vs-override** toggle.
- **Columns:** service, customer, rate_limit_id, `limit_value`, `time_unit`
  (unit), and a **Default / Override** badge. A row with `customer_id = '*'` is
  rendered as the **Default** for its `(service, rate_limit_id)`; any exact
  customer row is an **Override** (matching resolution semantics in parent §6.2,
  "exact wins over default").
- **Effective-limit hint:** when filtering by a concrete customer, the browser
  shows both the exact override (if any) **and** the `'*'` default it would fall
  back to, so a viewer can see what actually applies without re-deriving §6.2 in
  their head. If neither exists, it shows *"unconfigured → allow (fail-open,
  parent §9)"* — an important, non-obvious state.
- **Row actions:** open in the Limit Editor (§2.2), jump to Live Usage (§2.4)
  for that key, or open the Audit trail (§2.6) filtered to that `config_id`.
- Read-heavy and cacheable (§8.3); backed by `ListLimits` (§5.1).

### 2.2 Limit Editor (write)

Create, update, or delete a single limit, including `'*'` default rows.

- **Fields:** `service_name` (scoped select), `customer_id` (text; `'*'` allowed
  and clearly labeled "Default for all customers of this rate_limit_id"),
  `rate_limit_id` (text), `limit_value` (int ≥ 0), `time_unit`
  (MINUTE / DAY / MONTH).
- **Validation (client + BFF, authority in quotamgmt):**
  - `limit_value >= 0` (mirrors the `CHECK (limit_value >= 0)` constraint).
  - `time_unit ∈ {MINUTE, DAY, MONTH}`.
  - Uniqueness on `(service_name, customer_id, rate_limit_id)` — mirrors
    `uq_limit`; on create we pre-check and, on the race, surface quotamgmt's
    unique-violation as a friendly "a limit already exists for this tuple; edit
    it instead."
  - `service_name` must reference a registered `service` (FK in schema, §2.3).
- **Default management:** the editor makes the `'*'` concept explicit. A
  dedicated "Set a default for this rate_limit_id" affordance pre-fills
  `customer_id = '*'`. When editing a default, a warning notes its blast radius:
  "applies to every customer of `<service>/<rate_limit_id>` without an explicit
  override."
- **Confirmation & diff:** before any write, show a **before → after** diff (the
  same shape stored as `old_row`/`new_row` in `limit_config_audit`). Deletes
  require typing the tuple to confirm and — if it is a `'*'` default or a
  high-traffic limit — an optional two-person review (§9.2).
- Backed by `CreateLimit` / `UpdateLimit` / `DeleteLimit` (§5.1). Every write
  flows through quotamgmt with `app.actor` set to the signed-in user (§4.4), so
  `changed_by` in the audit row is correct.

### 2.3 Service Registration / Management (write)

Manage rows in the `service` table (schema lines 14–19): `service_name`,
`display_name`, `owner`.

- **List** registered services (scoped); **create** a new one (gated per §1.4
  note ¹); **edit** `display_name` / `owner`.
- `service_name` is the primary key and immutable once created (it is the FK
  target for every `limit_config` row); the UI enforces this and offers "create
  new + migrate" guidance rather than rename.
- Deleting a service is **blocked** while any `limit_config` rows reference it
  (the FK would reject it anyway); the UI explains this and links to the
  dependent limits.
- Backed by `ListServices` / `CreateService` / `UpdateService` (§5.4).

### 2.4 Live Usage Viewer (read)

Look up the current counter state for a `(service, customer, rate_limit_id)` and
window — the parent doc's "live usage inspection" (§5.1).

- **Input:** the tuple + a resolved window (the viewer computes `window_id` from
  `time_unit` and now-UTC per parent §6.1, or lets the user pick a specific
  window). The user does not have to know the `window_id` encoding.
- **Output:** `consumed`, `remaining` (`limit - consumed`, may be negative — by
  design, parent §6.4), `limit`, and `reset_at`. A negative `remaining` is
  badged "over quota (bounded overshoot, parent §6.4)" so operators don't panic.
- **Source:** the **quotaenforcer read API** (§5.2), which fronts Redis. `quotaui`
  **never** talks to Redis directly (parent §5.1). If quotaenforcer's read API is
  unavailable, the viewer shows "live usage temporarily unavailable" and the rest
  of the console keeps working — usage is a read-only convenience, not a
  dependency of config editing.
- **Not cached (or very short TTL only).** Unlike config, live usage is the one
  view where staleness misleads; we fetch fresh and label the fetch time.

### 2.5 Manual Operations (write / remediation)

The remediation surface from parent §5.1 ("adjust a limit, issue a
refund/credit, reset a customer's window"). Crucially, **these map onto existing
quotamgmt/quotaenforcer APIs — no special backdoor** (parent §5.1).

| Operation | Mapped API | What it does | Guardrails |
|---|---|---|---|
| **Adjust a limit** | `UpdateLimit` (quotamgmt) | Raise/lower `limit_value` for a tuple. | Diff + confirm (§2.2). Audited. |
| **Refund / credit** | `Refund` on the quotaenforcer op API (§5.3) | Return quota to a customer's current-window bucket, floored at 0 (parent §6.5). Used to undo an erroneous charge. | operator+; confirm; audited in quotaui's own action log (§9.3). Amount capped; UI warns a cross-window refund over-credits the *new* window (parent §6.5 edge case). |
| **Reset a customer's window** | `Refund` of the full `consumed`, or a targeted counter reset via quotaenforcer's admin op (§5.3) | Unblock someone throttled by a mistake by returning `remaining` to full for the current window. | operator+; **two-person review** by default for `'*'`/high-traffic keys (§9.2); confirm; audited. |

Design note — **why reuse `Refund` rather than a bespoke "reset" write to
Redis:** the parent doc is explicit that manual ops "map onto the existing
`Refund` / config APIs; no special backdoor" (§5.1). Reusing `Refund` keeps the
data-plane surface small, keeps atomicity/TTL semantics correct (the Lua `REFUND`
preserves the window TTL, parent Appendix B.2), and means remediation is subject
to the same code path we already trust in production. A window "reset" is
expressed as a refund of the current `consumed` (read it via §2.4, then refund
that amount). Where a true counter-clear is needed, it is an explicit,
audited **admin op on quotaenforcer** (§5.3) — still not a direct Redis write
from `quotaui`.

Every manual op is confirmed, shows a before/after (from Live Usage), and is
recorded (§9.3). Config-affecting ops land in `limit_config_audit`; data-plane
ops (refund/reset), which do not touch Postgres, are recorded in `quotaui`'s own
action log **and** correlated to quotaenforcer's request logs via a
`request_id`/actor tag (parent §7.2 — `request_id` is for tracing).

### 2.6 Audit / History Browser (read)

Browse `limit_config_audit` (schema lines 53–64): who changed what, when, and
the before/after — the parent doc's "audit & history" (§5.1), answering "why is
this customer's limit X?" and "who lowered it last Tuesday?".

- **Filters:** `config_id`, `service_name`, `customer_id`, `changed_by`,
  `operation` (INSERT/UPDATE/DELETE), and a `changed_at` time range (served off
  `idx_audit_changed_at` / `idx_audit_config`).
- **Rendering:** each entry shows `operation`, `changed_by`, `changed_at`, and a
  **field-level diff** of `old_row` → `new_row` (both are JSONB, so the UI diffs
  keys like `limit_value`, `time_unit`). DELETE shows the final `old_row`; INSERT
  shows the initial `new_row`.
- Deep-linked from the Limits Browser and Limit Editor (a row's "history" action
  opens this filtered to its `config_id`).
- Backed by `ListAudit` / `GetAuditForConfig` (§5.5). Read-only and cacheable
  with a short TTL (audit is append-only, so cached pages never go stale
  backwards).

### 2.7 Observability Surfacing (read)

Surface the operator-facing signals from parent §15: **throttle (deny) rate**,
**fail-open rate** (a key SLO — high fail-open means we're not actually
limiting), **top-throttled customers**, and **hot keys**.

- **Embedded compact panels** on the Limits Browser and per-service pages
  (throttle rate, fail-open rate, top-throttled customers for the service in
  view), fetched via quotaenforcer's aggregate metrics/read API (§5.6).
- **Deep links out** to the full Grafana/observability dashboards for anything
  richer (per-shard load, latency percentiles, expiry/reconnect spikes — parent
  §15). We deliberately do **not** rebuild those dashboards here (§1.3 non-goal);
  we surface the few numbers that answer "is this customer being throttled, and
  is enforcement actually working?" and link to the rest.

---

## 3. Architecture

`quotaui` is a **single-page application (SPA)** served to the browser, backed by
a **backend-for-frontend (BFF)**. The SPA renders and holds no secrets; the BFF
holds the session, enforces RBAC, and is the only thing that talks to quotamgmt
and quotaenforcer.

### 3.1 Data-flow diagram

```
        Browser (operator / service owner)
   ┌───────────────────────────────────────────┐
   │   quotaui SPA  (React + TypeScript)         │
   │   - renders pages §2                        │
   │   - RBAC-aware UX (hide/disable)            │
   │   - NO secrets, NO direct backend creds     │
   └───────────────┬─────────────────────────────┘
                   │ HTTPS, same-origin, session cookie
                   ▼
   ┌───────────────────────────────────────────┐
   │   quotaui BFF  (same stack as quotamgmt)    │
   │   - OIDC login / session (§4)               │
   │   - RBAC enforcement (AUTHORITY, §4.3)      │
   │   - request aggregation / shaping           │
   │   - holds service creds; no CORS exposure   │
   │   - emits UI action log (§9.3, §10)         │
   └───────┬───────────────────────────┬─────────┘
           │ authenticated, low-QPS     │
           │ actor = signed-in user     │
           ▼                            ▼
   ┌──────────────────┐        ┌─────────────────────────┐
   │  quotamgmt        │        │  quotaenforcer          │
   │  (control plane)  │        │  READ / op API only     │
   │  CRUD limits,     │        │  - live usage (Redis)   │
   │  services, audit  │        │  - Refund / reset op    │
   │  SET LOCAL        │        │  - aggregate metrics    │
   │   app.actor=user  │        │                         │
   └────────┬──────────┘        └───────────┬─────────────┘
            ▼                                ▼
     ┌─────────────┐                  ┌─────────────┐
     │  Postgres   │                  │   Redis     │
     │ config+audit│                  │  counters   │
     │ (src truth) │                  │ (live only) │
     └─────────────┘                  └─────────────┘

   NOTE: this entire diagram is OFF the request hot path. Consumer
   check/charge/refund traffic never traverses quotaui or its BFF.
```

This is the same shape as the parent doc's §5.1 "How it fits" sketch, expanded
with the SPA/BFF split and named components.

### 3.2 Why a BFF (trade-off callout)

A thick SPA calling quotamgmt/quotaenforcer directly from the browser was
considered and **rejected**. The BFF earns its keep:

- **Auth & session live server-side.** The OIDC token exchange and the session
  secret never reach the browser (§4). A pure SPA would have to hold tokens in
  JS-reachable storage — a bigger XSS blast radius.
- **RBAC is enforced where it has authority.** The browser cannot be trusted;
  the BFF is the choke point that maps the signed-in identity → allowed
  operations before any call reaches quotamgmt (§4.3). This is the same
  defense-in-depth as parent §16 (a producer may only touch its own service).
- **Identity → audit actor.** The BFF is where the authenticated user identity is
  attached to each quotamgmt call so `SET LOCAL app.actor` records the real human
  (§4.4). A browser-direct design would have to trust a client-asserted actor —
  unacceptable for an audit trail.
- **No CORS, no secret exposure.** SPA and BFF are same-origin, so no CORS
  relaxation and no cross-origin token handling. quotamgmt/quotaenforcer stay on
  the internal network, reachable only by the BFF's service identity (mTLS,
  parent §16).
- **Aggregation / shaping.** One screen often needs config + live usage + a
  metric (e.g. Live Usage viewer). The BFF fans out to quotamgmt and
  quotaenforcer and returns one shaped payload, so the SPA stays simple and
  chatty round trips stay server-side on the fast internal network.

Cost of the BFF: one more hop and one more deployable. Given the low QPS
(§8.2) this is negligible, and the security/audit benefits are decisive.

---

## 4. AuthN / AuthZ

### 4.1 Authentication — SSO / OIDC

Login is via the company IdP over **OIDC** (Authorization Code + PKCE). The BFF
is the OIDC *client*; the browser never sees the IdP tokens:

1. Unauthenticated request → BFF redirects to the IdP.
2. IdP authenticates the human, redirects back with an auth code.
3. BFF exchanges the code for tokens **server-side**, validates the ID token
   (issuer, audience, signature, expiry, nonce).
4. BFF establishes its **own** session and hands the browser an opaque,
   `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. No tokens in JS.

### 4.2 Session handling

- Server-side session (or a signed, encrypted stateless cookie) keyed to the
  opaque cookie; short idle timeout with sliding renewal, hard absolute cap.
- CSRF defense: `SameSite=Lax` plus a per-session CSRF token required on all
  state-changing (`POST`/`PUT`/`DELETE`) BFF routes.
- Logout clears the session both locally and (best effort) via IdP
  back-channel/RP-initiated logout.
- The user's roles/scopes (§1.4) are resolved at login from the IdP
  groups/claims (or an internal grant store the `admin` role manages) and cached
  on the session; re-resolved on renewal so revocations take effect promptly.

### 4.3 Authorization — RBAC in two layers

RBAC from §1.4 is enforced in **both** places the parent doc requires (§5.1):

- **Frontend (UX only, not authority).** The SPA hides/disables actions the user
  can't perform — no "Edit" button for a `viewer`, no other services in a
  `service-editor`'s service picker. This is purely to keep the UI honest and
  friendly; it is **never** relied on for security.
- **BFF (authority).** Every BFF route re-checks the session's roles/scopes
  against the requested operation **and target `service_name`** before calling
  quotamgmt/quotaenforcer. A forged or replayed request from a `viewer` to
  `UpdateLimit` is rejected at the BFF with `403`, regardless of what the SPA
  rendered. Scope checks resolve the target service from the request body/params
  and compare against the user's grants (e.g. `service-editor` on `search-svc`
  may not edit `payments-svc`).

Defense in depth: even past the BFF, quotamgmt applies its own service-scoped
authz (parent §16), so quotaui's BFF is not the only gate.

### 4.4 Identity → audit `changed_by`

This is the crux of the whole audit story. The chain:

```
signed-in human (OIDC subject / email)
   → BFF session
   → BFF calls quotamgmt with the caller identity attached
   → quotamgmt runs SET LOCAL app.actor = '<that human>'  (parent §5.1, Appendix B.1)
   → the limit_config trigger stamps changed_by = app.actor
   → limit_config_audit row attributes the change to the real person
```

The BFF passes the authenticated identity to quotamgmt on **every** write (as a
signed header / propagated identity on the mTLS call — never a
client-supplied field the browser could set). quotamgmt, as the parent doc
specifies, is the one that executes `SET LOCAL app.actor` from the authenticated
caller identity (locked decision). `quotaui` never sets `app.actor` itself and
never writes Postgres directly; it only ensures quotamgmt knows *who* the human
is. Result: `changed_by` is always a real human, and the audit trigger's "actor
must be set" guard (schema lines 72–74) is satisfied by a trustworthy value.

For data-plane manual ops (refund/reset, §2.5) that don't touch Postgres, the
same identity is attached to the quotaenforcer call and to quotaui's own action
log (§9.3), so those are attributable too.

---

## 5. API Contract Used by the UI

Every feature maps to concrete quotamgmt / quotaenforcer endpoints. The SPA only
ever calls **BFF** routes (same-origin `/api/...`); the BFF calls the endpoints
below. Sketches are illustrative JSON; the wire form follows quotamgmt's contract
(parent §3.3 control-plane API: `CreateLimit / UpdateLimit / DeleteLimit /
GetLimit / ListLimits`).

### 5.1 Config — quotamgmt (Limits Browser §2.1, Limit Editor §2.2)

```
GET    ListLimits(service_name?, customer_id?, rate_limit_id?, page)
   -> [ { id, service_name, customer_id, rate_limit_id, limit_value, time_unit } ]

GET    GetLimit(service_name, customer_id, rate_limit_id)
   -> { id, ...limit... } | 404 (unconfigured)

POST   CreateLimit { service_name, customer_id, rate_limit_id, limit_value, time_unit }
   -> 201 { id, ... }        // quotamgmt SET LOCAL app.actor = <user>; INSERT
   -> 409 if (service,customer,rate_limit_id) already exists  (uq_limit)

PUT    UpdateLimit { id | tuple, limit_value, time_unit }
   -> 200 { id, ... , old, new }     // returns diff for confirmation display

DELETE DeleteLimit { id | tuple }
   -> 204
```

`customer_id = '*'` in any of the above is the default row (parent §6.2); the BFF
does not special-case it beyond labeling — quotamgmt/Postgres treat it as a
normal row with a reserved id.

### 5.2 Live usage — quotaenforcer read API (Live Usage Viewer §2.4)

```
GET  ReadUsage(service_name, customer_id, rate_limit_id, window?)
   -> { limit, consumed, remaining, reset_at, window_id, fetched_at }
```

Fronts Redis (parent §5.1, §6.3 `CHECK` is read-only). `remaining` may be
negative (parent §6.4). If the tuple is unconfigured, returns
`limit=null, note="unconfigured → fail-open"`.

### 5.3 Manual ops — quotaenforcer op API (Manual Operations §2.5)

```
POST Refund { service_name, customer_id, rate_limit_id, amount, request_id, actor }
   -> { remaining, limit, reset_at }        // parent §6.5 / Appendix B.2 REFUND

POST ResetWindow { service_name, customer_id, rate_limit_id, window?, actor }
   -> { remaining=limit, ... }              // expressed as Refund(consumed) or admin op
```

Both carry the authenticated `actor` (§4.4) and a `request_id` for tracing
(parent §7.2). These are the **only** quotaenforcer write surface `quotaui`
touches, and they are the same `Refund` path production already uses — no
backdoor (parent §5.1).

### 5.4 Services — quotamgmt (Service Management §2.3)

```
GET  ListServices(scope)            -> [ { service_name, display_name, owner, created_at } ]
POST CreateService { service_name, display_name, owner }   -> 201
PUT  UpdateService { service_name, display_name?, owner? }  -> 200
```

### 5.5 Audit — quotamgmt (Audit Browser §2.6)

```
GET ListAudit(service_name?, customer_id?, changed_by?, operation?, from?, to?, page)
   -> [ { audit_id, config_id, operation, old_row, new_row, changed_by, changed_at } ]

GET GetAuditForConfig(config_id)
   -> [ ... same shape, ordered by changed_at ]    // uses idx_audit_config
```

### 5.6 Observability — quotaenforcer metrics/read (Observability §2.7)

```
GET Metrics(service_name?, window)
   -> { throttle_rate, fail_open_rate, top_throttled: [{customer_id, deny_count}], hot_keys: [...] }
```

Sourced from the metrics quotaenforcer already emits (parent §15). Anything
richer is a deep link to Grafana, not a BFF call.

---

## 6. Key-Screen Wireframes

ASCII mockups of the four load-bearing screens.

### 6.1 Limits Browser (§2.1)

```
┌ quotaui ─────────────────────────────────  alice (operator)  ▾ ┐
│ Limits │ Services │ Live Usage │ Audit │ Dashboards            │
├────────────────────────────────────────────────────────────────┤
│ Service [ search-svc ▾]  Customer [ cust_42     ]  RL id [    ] │
│ Show: (•) all  ( ) defaults only  ( ) overrides only   [Search]│
├────────────────────────────────────────────────────────────────┤
│ Service     Customer   RL id     Limit   Unit    Kind    ▾      │
│ search-svc  cust_42    default   1000    MINUTE  OVERRIDE [Edit]│
│ search-svc  *          default    500    MINUTE  DEFAULT  [Edit]│
│ search-svc  cust_99    export      10    DAY     OVERRIDE [Edit]│
│ search-svc  *          export       5    DAY     DEFAULT  [Edit]│
├────────────────────────────────────────────────────────────────┤
│ Effective for cust_42 / default:  1000/min (override)          │
│   falls back to *: 500/min  ·  [Live usage]  [History]         │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 Limit Editor (§2.2)

```
┌ Edit limit ────────────────────────────────────────────────┐
│ Service        [ search-svc ▾]     (you own this service)   │
│ Customer       [ cust_42        ]  ☐ Default ('*') for all  │
│ Rate limit id  [ default        ]                           │
│ Limit value    [ 1000           ]  must be ≥ 0              │
│ Unit           (•) MINUTE ( ) DAY ( ) MONTH                 │
├────────────────────────────────────────────────────────────┤
│ Change preview (→ limit_config_audit):                     │
│   limit_value:  1000  →  2000                              │
│   time_unit:    MINUTE (unchanged)                         │
│   changed_by:   alice   (you)                             │
├────────────────────────────────────────────────────────────┤
│                       [Cancel]   [Save change]             │
└────────────────────────────────────────────────────────────┘
  Delete?  type  search-svc/cust_42/default  to confirm  [Delete]
```

### 6.3 Live Usage Viewer (§2.4)

```
┌ Live usage  (source: quotaenforcer read API → Redis) ──────┐
│ Service [search-svc▾] Customer [cust_42] RL id [default]   │
│ Window  (•) current minute  ( ) pick…            [Lookup]  │
├────────────────────────────────────────────────────────────┤
│   limit       1000                                         │
│   consumed    1003                                        │
│   remaining   -3   ⚠ over quota (bounded overshoot §6.4)  │
│   reset_at    2026-07-12 14:05:00 UTC  (in 22s)          │
│   window_id   202607121404      fetched 14:04:38 UTC     │
├────────────────────────────────────────────────────────────┤
│  [Refund…]  [Reset window…]      (operator only)          │
└────────────────────────────────────────────────────────────┘
```

### 6.4 Audit / History Browser (§2.6)

```
┌ Audit / history ───────────────────────────────────────────┐
│ Service[search-svc▾] Customer[      ] By[      ] Op[ all ▾] │
│ From [2026-07-01] To [2026-07-12]                 [Search] │
├────────────────────────────────────────────────────────────┤
│ When (UTC)         By      Op      Config       Change      │
│ 07-09 16:02  bob     UPDATE  #1841   limit 500→1000        │
│ 07-05 11:20  alice   INSERT  #1841   +1000/min cust_42     │
│ 07-02 09:14  alice   DELETE  #1502   -5/day cust_13        │
├────────────────────────────────────────────────────────────┤
│ ▸ #1841 UPDATE by bob @ 07-09 16:02                        │
│     old_row: { limit_value: 500,  time_unit: MINUTE }     │
│     new_row: { limit_value: 1000, time_unit: MINUTE }     │
└────────────────────────────────────────────────────────────┘
```

---

## 7. Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| SPA | **React + TypeScript** | Standard, well-known, strong typing over the API contract (§5); large hiring pool internally. |
| State/data | Typed data-fetching (e.g. TanStack Query) | Built-in cache/stale-while-revalidate for the read-heavy views (§8.3); mirrors the parent doc's caching philosophy (§12.4). |
| BFF | **Same language/stack as quotamgmt** | Share the generated client, types, auth libs, and mTLS/service-identity setup with quotamgmt; one fewer runtime to operate; keeps the identity→`app.actor` plumbing (§4.4) consistent with the control plane it fronts. |
| Transport SPA↔BFF | HTTPS JSON, same-origin | No CORS, session cookie (§4.1). |
| Transport BFF↔services | Whatever quotamgmt/quotaenforcer expose (gRPC per parent §3.1, or their HTTP gateway) over mTLS | Reuse existing service identity + authz (parent §16). |
| Build/deploy | Static SPA bundle served by the BFF (or a CDN/static host) + containerized BFF | Simple; SPA can even be served by the BFF to guarantee same-origin. |

### 7.1 Theming & accessibility

- **Accessibility:** target WCAG 2.1 AA — full keyboard navigation (operators
  live on the keyboard during incidents), visible focus states, ARIA on the data
  tables and dialogs, and **do not encode state by color alone** (the
  Default/Override and over-quota badges carry text + icon, not just hue —
  see §6). Confirmation dialogs are focus-trapped and screen-reader announced.
- **Theming:** light/dark via CSS custom properties; a small, neutral design
  system. This is an internal tool — clarity and density beat visual flourish.
- **Density:** operator-oriented tables are compact with sticky headers and
  server-side pagination (§8.3) so large services stay usable.

---

## 8. Non-Functional Requirements

### 8.1 Availability independent of enforcement

The headline property (parent §5.1). `quotaui` and its BFF can be down, slow, or
mid-deploy and **enforcement is unaffected** — quotaenforcer and the client SDKs
never call quotaui. We therefore run `quotaui` at a **lower availability tier**
than the data plane: a single-region active/standby BFF is fine; no multi-AZ
heroics are required for correctness (though cheap to have). Conversely, quotaui
depends on quotamgmt for writes and quotaenforcer's read API for live usage — but
degrades gracefully when either is unavailable (config editing survives a
quotaenforcer read outage, §2.4; the console is read-only-degraded if quotamgmt
is down).

### 8.2 Low QPS

Traffic is human-driven: a handful of operators and service owners, a few
requests per interaction. Orders of magnitude below the data plane. This lets us
keep the BFF small and cheap, and makes aggressive caching (§8.3) safe. It also
means quotaui's calls to quotamgmt/quotaenforcer are a rounding error against
their real load — surfacing config/audit/usage through the UI adds negligible
load to the control and data planes.

### 8.3 Caching of read-heavy views

Following the parent doc's caching discipline (§12.4), but for a UI:

- **Limits Browser, Services, Audit:** short-TTL cached in the BFF and in the
  SPA data layer, with stale-while-revalidate. Audit is append-only so caches
  never go backwards; config changes are rare so a short TTL is fine, and the
  BFF can invalidate the relevant cache entry immediately after a write it
  performed.
- **Live Usage:** **not** cached (or ≤1–2 s), because staleness there is
  misleading (§2.4). This is the deliberate exception.
- **Observability panels:** cached to the metric's natural resolution (tens of
  seconds); these are trend indicators, not precise instruments.

Caching here is a cost/latency nicety, never a correctness dependency — a cold
cache just means a couple of extra low-QPS calls to quotamgmt.

---

## 9. Safety

Every mutating action in `quotaui` is deliberate, reversible-where-possible, and
attributable. Three mechanisms, escalating with blast radius.

### 9.1 Confirmation & diff on every write

No write happens without a **before → after** preview (§2.2, §6.2) that shows
exactly what will change and who it will be attributed to. This mirrors the audit
`old_row`/`new_row` shape so the operator sees precisely what will land in
`limit_config_audit`. Deletes require typing the tuple to confirm.

### 9.2 Two-person review for destructive / high-blast-radius ops

For actions with large blast radius the parent doc flags for "two-person review"
(§5.1), quotaui supports an **optional maker-checker** flow, on by default for:

- deleting or editing a **`'*'` default** (affects every customer of a
  `(service, rate_limit_id)` without an override), and
- **window resets / large refunds** on high-traffic keys.

Flow: the initiator (a `service-editor` or `operator`) submits the change, which
enters a **pending** state and is *not* applied. A **different** `operator`/`admin`
(the initiator may not approve their own — §1.4 note ²) reviews the diff and
approves or rejects. Only on approval does the BFF call quotamgmt/quotaenforcer.
Both the initiator and approver are recorded (§9.3), and the resulting config
write still stamps `changed_by` via `app.actor` (the applying identity, with the
initiator/approver pair captured in quotaui's action log for the full story).
Whether a given class of change requires review is a per-service policy knob.

### 9.3 Full audit of UI-initiated actions

- **Config changes** are audited by construction: they flow through quotamgmt and
  land in `limit_config_audit` with a correct human `changed_by` (§4.4). This is
  the system of record for config history (parent Appendix B.1).
- **Data-plane manual ops** (refund/reset) don't touch Postgres, so quotaui keeps
  its **own append-only action log** — actor, target tuple, operation, amount,
  timestamp, and the two-person initiator/approver pair — and tags the
  quotaenforcer call with the actor + a `request_id` so it correlates with the
  data plane's own request logs (parent §7.2). Nothing a human does in quotaui is
  unattributable.

There is, by design, **no path** in quotaui to change config or counters that
bypasses these — all writes go through quotamgmt/quotaenforcer (locked decision);
the BFF has no direct DB/Redis credentials.

---

## 10. Observability of quotaui itself, Testing & Rollout

### 10.1 Observability of the UI / BFF

Distinct from the *product* observability quotaui *surfaces* (§2.7), the
component itself is monitored:

- **BFF metrics:** request rate/latency/error rate per route, login
  success/failure, session count, RBAC-denial (`403`) rate (a spike may mean a
  broken grant or an attempted misuse), and per-downstream (quotamgmt /
  quotaenforcer) call latency + error rate.
- **Availability SLO** for quotaui is set **below** the data plane's — an
  explicit statement that this component is not safety-critical (§8.1). Its being
  down pages the quotaui owners, not the enforcement on-call.
- **Action-log health:** alert if a mutating call succeeded downstream but its
  quotaui action-log write failed (we must never lose attribution).
- **Tracing:** propagate a trace/`request_id` from SPA → BFF → quotamgmt /
  quotaenforcer so a human action is followable end to end (parent §7.2).

### 10.2 Testing

- **Unit:** validation rules (§2.2), RBAC decision logic (§4.3), the
  identity→actor plumbing (§4.4).
- **Contract tests** against quotamgmt/quotaenforcer stubs so the API map (§5)
  can't drift silently.
- **RBAC/authorization tests** are first-class: assert that a `viewer` cannot
  mutate, a `service-editor` cannot touch a service they don't own, and the BFF
  rejects forged requests regardless of SPA state (the frontend layer is never
  trusted).
- **Audit-correctness test:** a config change made through the UI produces a
  `limit_config_audit` row with the expected `changed_by` and before/after —
  end-to-end, against a real quotamgmt + Postgres in a test env.
- **End-to-end (Playwright/Cypress):** the four key flows of §6, including the
  two-person review path (§9.2) and the destructive-confirm gates.
- **Accessibility checks** (axe) in CI against §7.1.

### 10.3 Rollout

Aligned with the parent rollout plan (§19), quotaui rides behind the control
plane it fronts:

1. **Read-only first.** Ship the Limits Browser, Live Usage, and Audit viewers
   (§2.1, §2.4, §2.6) against a live quotamgmt/quotaenforcer. Zero write risk;
   immediately useful for support/on-call, and validates the API map (§5) and
   the identity/SSO plumbing under real use.
2. **Guarded writes.** Enable the Limit Editor and Service management (§2.2,
   §2.3) for a small set of `service-editor`/`operator` users, with confirmation
   + audit on from day one. Verify `changed_by` correctness in `limit_config_audit`
   against real edits before widening access.
3. **Manual ops + two-person review.** Turn on refund/credit and window reset
   (§2.5) for `operator`s, with two-person review defaulted on for defaults and
   high-traffic keys (§9.2).
4. **Observability surfacing + polish** (§2.7); broaden RBAC grants; document
   runbooks that point on-call at quotaui for the common "unblock a customer"
   and "why is this limit X?" tasks.

Because quotaui is off the hot path (§8.1), every stage is low-risk: the worst
failure mode of a quotaui bug is a bad *config write* — which is caught by the
diff/confirm gates (§9.1), bounded by RBAC (§4.3), fully audited and therefore
reversible (§9.3), and even then only affects enforcement *accuracy*, never
availability (parent §9 fail-open).

---

## 11. Cross-References

- `regional-rate-limiter-design.md` §5 (architecture), **§5.1 (Internal Admin
  UI — the parent of this doc)**, §3.3 (control-plane API), §6.2 (limit
  resolution / `'*'` default), §6.4–6.5 (charge overshoot / refund floor), §7.2
  (`request_id` for tracing), §9 (fail-open), §15 (observability), §16
  (security / multi-tenancy), Appendix B.1 (Postgres config + audit,
  `SET LOCAL app.actor`), Appendix B.2 (Redis / Lua ops).
- `schema/postgres.sql` — `service`, `limit_config`, `limit_config_audit`, and
  the `app.actor` audit trigger this UI's writes rely on.
- `schema/redis_scripts.lua` — the `REFUND` op the manual-remediation flows
  (§2.5) reuse.
- `design/quotamgmt.md` — the control-plane API the BFF calls for all config /
  service / audit operations.
- `design/quotaenforcer.md` — the data-plane read/op API the BFF calls for live
  usage and refund/reset.
