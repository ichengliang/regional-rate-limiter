# Detailed Design: `quotamgmt` — Control Plane

**Status:** Draft
**Author:** chengliangzhang@gmail.com
**Date:** 2026-07-12
**Parent:** [`regional-rate-limiter-design.md`](../regional-rate-limiter-design.md) (high-level design)
**Siblings:** `quotaenforcer` (data plane) · `quotaui` (admin UI)

---

## 1. Overview

`quotamgmt` is the **control plane** of the regional rate limiting service. It
owns rate-limit **configuration** and its **audit trail**, and it feeds that
configuration to the data plane (`quotaenforcer`). It is the concrete
realization of the "Control-Plane API" box in the high-level architecture
(parent §5, §5.1) and the durable source of truth described in parent Appendix B.1.

Everything `quotamgmt` does is **low-QPS, strongly consistent, and audited**.
It is the opposite of `quotaenforcer` in every axis that matters: writes are
rare, correctness beats latency, and Postgres — not Redis — is the store.

This document details `quotamgmt`. It does **not** cover implementation. Where a
decision was already made in the parent doc, this document honors it and points
back rather than re-litigating (parent §17 for the full trade-off table).

### 1.1 Responsibilities

- Expose the **CRUD API** for rate-limit config: `CreateLimit`, `UpdateLimit`,
  `DeleteLimit`, `GetLimit`, `ListLimits` (§3).
- Manage **default limits** (`customer_id = '*'`) and **service registration**
  (§3.6, §3.7).
- Enforce **validation, authN/Z, and tenant scoping** on every write (§3.8, §7).
- Write every mutation through the **audited path** — `SET LOCAL app.actor`,
  trigger-populated `limit_config_audit` (§4.4).
- Serve the **config change-feed** the data plane consumes: watermark polling on
  `limit_config_audit.changed_at`, `LISTEN/NOTIFY` push, and snapshot bootstrap
  (§5).
- Provide **read APIs** for `quotaui` and programmatic clients to browse config
  and audit history.

### 1.2 Scope & Non-Goals

- **Not in the request hot path.** `quotamgmt` is never called during
  `check`/`charge`/`refund`. The data plane resolves limits from its *local
  config cache* (parent §6.2), which `quotamgmt` populates asynchronously via the
  change-feed. If `quotamgmt` is completely down, enforcement continues on cached
  config and ultimately fails open (parent §9). This is the single most important
  property of the component and is defended in §8.
- **Not the counter store.** Live `consumed` counters live in Redis and are owned
  by `quotaenforcer` (parent §4.2, Appendix B.2). `quotamgmt` never reads or
  writes them. Live-usage inspection in `quotaui` goes through the
  `quotaenforcer` read API, not through `quotamgmt` (parent §5.1).
- **Not authorization of end-consumers.** We store *who may edit config* (§7);
  we do not decide whether an end consumer may call a producer's API. That is the
  producer's concern (parent §1.2).
- **Not billing.** We store caps, not money (parent §1.2).
- **No new algorithms or failure modes.** Fixed-window only, fail-open only
  (parent §1, §6, §9). Neither is a column (parent Appendix B.1); `quotamgmt`
  cannot express anything else, by construction.

---

## 2. Position in the System

```
   quotaui  ──HTTPS (SSO+RBAC)──┐
                                │           programmatic clients
   programmatic ──mTLS──────────┤            (service owners' CI,
   clients                      │             IaC, scripts)
                                ▼
                    ┌──────────────────────────┐
                    │        quotamgmt          │  stateless API tier
                    │  - CRUD + validation      │  (autoscaled, low QPS)
                    │  - authZ / tenant scoping │
                    │  - audited writes         │
                    │  - change-feed endpoints  │
                    └───────┬───────────┬───────┘
                            │           │
             writes/reads   │           │  LISTEN/NOTIFY + watermark poll
                            ▼           ▼
                    ┌──────────────────────────┐   config feed
                    │  Postgres (source of      │─────────────────▶  quotaenforcer
                    │  truth: config + audit)   │                    (per region:
                    │  primary + read replicas  │                     local config
                    │  globally replicated      │                     cache → Redis)
                    └──────────────────────────┘
```

- **Callers of `quotamgmt`:** `quotaui` (human operators / service owners) and
  **programmatic clients** (a producer's CI pipeline, IaC, or admin scripts). Both
  hit the same CRUD surface; `quotaui` adds SSO + a UX layer (its doc), programmatic
  clients authenticate with service identity (§7).
- **How the data plane gets config:** `quotaenforcer` does **not** call the CRUD
  API. It consumes the **change-feed** (§5) — watermark poll + `LISTEN/NOTIFY` —
  and bootstraps from a **snapshot** on cold start. This keeps the data plane
  decoupled from `quotamgmt`'s availability.
- **Global replication:** config is written to a primary and replicated to every
  region (§9.3), so a limit created anywhere is enforceable everywhere (parent
  §11).

---

## 3. API Design

Transport is **gRPC** with an HTTP/JSON gateway, matching the data plane's
transport choice (parent §3.1). The control plane is low-QPS, so the gateway
overhead is irrelevant here; it exists for `quotaui` and curl-friendly scripts.

All RPCs live under `quotamgmt.v1.LimitAdmin`. Schemas below are proto; the JSON
gateway representation is the canonical proto3 JSON mapping.

### 3.1 Core types

```proto
enum TimeUnit {              // mirrors Postgres time_unit enum
  TIME_UNIT_UNSPECIFIED = 0; // invalid on write; rejected
  MINUTE = 1;
  DAY    = 2;
  MONTH  = 3;
}

// The identity of a limit is the tuple (service_name, customer_id, rate_limit_id).
// customer_id = "*" is the per-(service, rate_limit_id) DEFAULT (§3.6).
message LimitKey {
  string service_name  = 1;
  string customer_id   = 2;  // "*" => default row
  string rate_limit_id = 3;
}

message Limit {
  LimitKey key         = 1;
  int64    limit_value = 2;   // the cap; >= 0
  TimeUnit time_unit   = 3;
  int64    config_id   = 4;   // limit_config.id; server-assigned, read-only
}
```

Note there is **no** `region`, `enabled`, `created_at`, `updated_at`, or
`version` field — consistent with the lean `limit_config` table (parent Appendix
B.1). Who/when history lives in the audit trail (§4.4, §3.9), retrieved
separately.

### 3.2 `CreateLimit`

```proto
rpc CreateLimit(CreateLimitRequest) returns (CreateLimitResponse);

message CreateLimitRequest {
  LimitKey key         = 1;   // required; customer_id may be "*"
  int64    limit_value = 2;   // required; >= 0
  TimeUnit time_unit   = 3;   // required; not UNSPECIFIED
}
message CreateLimitResponse { Limit limit = 1; }
```

- Inserts one `limit_config` row. Fails with `ALREADY_EXISTS` if the
  `(service_name, customer_id, rate_limit_id)` tuple already exists (the
  `uq_limit` constraint, parent Appendix B.1). Callers wanting upsert semantics
  use `UpdateLimit` with `create_if_absent` (§3.3).
- Emits an `INSERT` audit row (`old_row = NULL`, `new_row = to_jsonb(NEW)`).

### 3.3 `UpdateLimit`

```proto
rpc UpdateLimit(UpdateLimitRequest) returns (UpdateLimitResponse);

message UpdateLimitRequest {
  LimitKey key              = 1;   // required; identifies the row
  int64    limit_value      = 2;   // required; >= 0
  TimeUnit time_unit        = 3;   // required
  bool     create_if_absent = 4;   // optional upsert
}
message UpdateLimitResponse { Limit limit = 1; }
```

- Updates `limit_value` and/or `time_unit` for an existing row. The **key is
  immutable**: to "move" a limit to a different customer, delete + create (two
  audited operations). This keeps `config_id` stable for a given tuple, which the
  change-feed relies on.
- If the row does not exist: `NOT_FOUND`, unless `create_if_absent = true`, in
  which case it behaves as `CreateLimit` (and emits an `INSERT`, not `UPDATE`,
  audit row).
- **Last-writer-wins.** No optimistic-concurrency token (parent §17, Appendix
  B.1 "No optimistic-concurrency column"). Concurrent updates serialize in
  Postgres; the later commit wins and both are captured in the audit trail (§6).
- Emits an `UPDATE` audit row with full before/after.

### 3.4 `DeleteLimit`

```proto
rpc DeleteLimit(DeleteLimitRequest) returns (DeleteLimitResponse);

message DeleteLimitRequest {
  LimitKey key         = 1;   // required
  bool     allow_missing = 2; // if true, deleting a non-existent row is OK (idempotent)
}
message DeleteLimitResponse {}
```

- Deletes the row. There is **no `enabled` flag** — removing a limit *is* deleting
  the row (parent Appendix B.1). Consequences:
  - Deleting an **exact customer row** → that customer falls back to the `'*'`
    default (if any) on the data plane's next resolution; if no default exists,
    the customer becomes *unconfigured* → **allow** (parent §6.2, §9).
  - Deleting a **`'*'` default row** → every customer without an explicit row for
    that `(service, rate_limit_id)` becomes unconfigured → **allow**. This is a
    high-blast-radius operation; `quotaui` gates it behind confirmation / two-person
    review (parent §5.1), and RBAC scopes who can do it (§7).
- Emits a `DELETE` audit row (`old_row = to_jsonb(OLD)`, `new_row = NULL`).
- Idempotency: without `allow_missing`, deleting a non-existent row returns
  `NOT_FOUND`; with it, returns OK and writes **no** audit row (nothing changed).

> **Trade-off — delete vs. soft-disable.** The parent doc deliberately has no
> `enabled` column. A soft-disable would keep the row and let you re-enable
> without re-entering the value, but it adds a column to the "lean" table and a
> second notion of "does this limit apply?" that the resolution query (§4.2) would
> have to filter on. We keep delete-only; the audit trail retains the old value,
> so a mistaken delete is recoverable by reading `old_row` and re-creating.

### 3.5 `GetLimit` / `ListLimits`

```proto
rpc GetLimit(GetLimitRequest) returns (GetLimitResponse);
message GetLimitRequest {
  LimitKey key      = 1;   // exact-tuple lookup; "*" allowed to fetch a default
  bool     resolve  = 2;   // if true and exact row absent, return the '*' default
}
message GetLimitResponse {
  Limit limit    = 1;
  bool  is_default = 2;    // true if the returned row is the '*' default (resolve mode)
}

rpc ListLimits(ListLimitsRequest) returns (ListLimitsResponse);
message ListLimitsRequest {
  string   service_name  = 1;  // required (tenant scope, §7)
  string   customer_id   = 2;  // optional filter; "*" lists only defaults
  string   rate_limit_id = 3;  // optional filter
  int32    page_size     = 4;  // default 100, max 1000
  string   page_token    = 5;  // opaque cursor (keyset on id)
}
message ListLimitsResponse {
  repeated Limit limits         = 1;
  string         next_page_token = 2;
}
```

- `GetLimit` with `resolve = false` is a pure row fetch by tuple. With
  `resolve = true`, it runs the **exact-then-default resolution** the data plane
  uses (§4.2) and reports which one matched via `is_default`. This lets an
  operator answer "what limit would `cust_42` actually get?" from `quotaui`.
- `ListLimits` is **always scoped to one `service_name`** (required), which is the
  RBAC boundary (§7). Pagination is keyset on `limit_config.id` (stable, no
  offset scan). These are read-only and may be served from a **read replica**
  (§9.2) since a few seconds of staleness on an admin list is harmless.

### 3.6 Default-limit management

Defaults are **not a separate API** — they are ordinary `limit_config` rows with
`customer_id = '*'`. `CreateLimit`/`UpdateLimit`/`DeleteLimit` with
`customer_id = "*"` manage them. This is intentional: one table, one resolution
rule (§4.2), one audit path. The only special handling is:

- **Validation** treats `'*'` as a reserved literal — a real customer id may not
  be the single character `*` (§3.8).
- **`quotaui`** renders `'*'` rows in a distinct "default" section and flags
  their higher blast radius (§3.4), but the wire contract is identical.

### 3.7 Service registration

```proto
rpc RegisterService(RegisterServiceRequest) returns (RegisterServiceResponse);
message RegisterServiceRequest {
  string service_name = 1;  // primary key; immutable
  string display_name = 2;
  string owner        = 3;  // team/identity that owns limits for this service
}
message RegisterServiceResponse { /* echoes the stored row */ }

rpc GetService(...) returns (...);
rpc ListServices(...) returns (...);
```

- Backs the `service` table (parent Appendix B.1). A `limit_config` row's
  `service_name` **FKs to `service`**, so a service must be registered before any
  limit references it — `CreateLimit` for an unregistered service returns
  `FAILED_PRECONDITION`.
- `owner` seeds RBAC (§7): the owning team is granted editor rights on that
  service's limits.
- Service registration is itself a privileged operation (platform-admin role,
  §7); a producer cannot self-register another team's service name.

### 3.8 Validation rules

Applied before any DB write; violations return `INVALID_ARGUMENT` with a
machine-readable `field` and reason.

| Field | Rule |
|-------|------|
| `service_name` | non-empty; `^[a-z0-9][a-z0-9-]{0,62}$`; must exist in `service` (FK). |
| `customer_id` | non-empty; length ≤ 128; the literal `*` is allowed **only** as the default marker; a real id may not be `*`. |
| `rate_limit_id` | non-empty; `^[a-z0-9][a-z0-9._-]{0,127}$`. |
| `limit_value` | integer, `>= 0` (mirrors `CHECK (limit_value >= 0)`). `0` is valid and means "deny everything" (cap of zero), distinct from *unconfigured* (no row) which means allow. |
| `time_unit` | one of `MINUTE`/`DAY`/`MONTH`; `UNSPECIFIED` rejected. |
| `page_size` | clamped to `[1, 1000]`. |

> **`limit_value = 0` vs. no row.** These are semantically opposite and must not
> be confused (this mirrors the parent's "two absences" warning, §6.2). A `0` cap
> is an explicit *deny-all*; the data plane will compute `remaining = 0 - consumed`
> and deny. *No row* is *unconfigured* → allow. Validation permits `0`; operators
> are warned in `quotaui` because a `0` default is a service-wide outage switch.

### 3.9 Audit read API

```proto
rpc ListAuditEntries(ListAuditEntriesRequest) returns (ListAuditEntriesResponse);
message ListAuditEntriesRequest {
  string service_name = 1;   // tenant scope (§7); required
  LimitKey key        = 2;   // optional: history for one tuple
  int64  config_id    = 3;   // optional: history for one config_id
  google.protobuf.Timestamp since = 4;  // optional lower bound on changed_at
  int32  page_size    = 5;
  string page_token   = 6;
}
message AuditEntry {
  int64  audit_id   = 1;
  int64  config_id  = 2;
  string operation  = 3;     // INSERT | UPDATE | DELETE
  google.protobuf.Struct old_row = 4;
  google.protobuf.Struct new_row = 5;
  string changed_by = 6;
  google.protobuf.Timestamp changed_at = 7;
}
message ListAuditEntriesResponse {
  repeated AuditEntry entries = 1;
  string next_page_token      = 2;
}
```

This backs `quotaui`'s "who changed what, when, before/after" view (parent §5.1)
and reads directly from `limit_config_audit`. It is **not** the change-feed the
data plane uses (§5) — same table, different consumer and access pattern (this
one filters by `service_name`/`config_id` and is human-paced; the feed scans by
`changed_at` watermark).

### 3.10 Error codes

| gRPC code | HTTP | When |
|-----------|------|------|
| `OK` | 200 | success |
| `INVALID_ARGUMENT` | 400 | validation failure (§3.8); includes offending `field`. |
| `UNAUTHENTICATED` | 401 | missing/invalid identity (§7). |
| `PERMISSION_DENIED` | 403 | authenticated but not scoped to this `service_name` (§7). |
| `NOT_FOUND` | 404 | `Update`/`Delete`/`Get` on a nonexistent tuple (unless `create_if_absent`/`allow_missing`). |
| `ALREADY_EXISTS` | 409 | `CreateLimit` on an existing tuple (`uq_limit`). |
| `FAILED_PRECONDITION` | 412 | e.g. `CreateLimit` for an unregistered service (FK). |
| `ABORTED` | 409 | serialization failure on a rare concurrent write (§6); client may retry. |
| `RESOURCE_EXHAUSTED` | 429 | admin-tier rate limit tripped (§7.4). |
| `UNAVAILABLE` | 503 | Postgres primary unreachable on a **write** (§8). Reads may still succeed from a replica. |
| `INTERNAL` | 500 | unexpected. |

Because `quotamgmt` is not in the hot path, a `503` here is an **operator-facing**
error, not a consumer-facing one — it never becomes a `429` to an end user.

### 3.11 Worked examples

The calls below use the HTTP/JSON gateway; the gRPC form is identical
field-for-field (`grpcurl` shown once). `Authorization: Bearer <sso-token>` is
required on every call (§7) and elided except where it drives the result. Field
names are the proto's `snake_case`; int64 fields (`limit_value`, `config_id`,
`audit_id`) are rendered as numbers for readability (canonical proto3 JSON
encodes int64 as strings).

The examples build one scenario: stand up `search-svc`, give it a 1000/min
default, override one customer, then inspect and edit.

**1 — Register the service** (must precede any limit for it; FK, §3.7)

```
grpcurl -H "authorization: Bearer $TOKEN" -d '{
  "service_name": "search-svc",
  "display_name": "Search Service",
  "owner": "search-team"
}' quotamgmt.internal:443 quotamgmt.v1.LimitAdmin/RegisterService
```

**2 — Create the per-service default** (`customer_id: "*"`, §3.6): 1000/min for
any customer without an override.

```
POST /v1/limits
{
  "key": { "service_name": "search-svc", "customer_id": "*", "rate_limit_id": "requests_per_min" },
  "limit_value": 1000,
  "time_unit": "MINUTE"
}
→ 200 OK
{
  "limit": {
    "key": { "service_name": "search-svc", "customer_id": "*", "rate_limit_id": "requests_per_min" },
    "limit_value": 1000, "time_unit": "MINUTE", "config_id": 8120
  }
}
```

**3 — Override one customer** — `cust_42` gets 5000/min.

```
POST /v1/limits
{ "key": { "service_name": "search-svc", "customer_id": "cust_42", "rate_limit_id": "requests_per_min" },
  "limit_value": 5000, "time_unit": "MINUTE" }
→ 200 OK
{ "limit": { "key": { "...": "cust_42" }, "limit_value": 5000, "time_unit": "MINUTE", "config_id": 8121 } }
```

**4 — Duplicate create → `ALREADY_EXISTS`** (§3.2, §3.10). Use `UpdateLimit` to change a value.

```
POST /v1/limits   { "key": { "...": "cust_42" }, "limit_value": 6000, "time_unit": "MINUTE" }
→ 409 Conflict
{ "code": 6, "status": "ALREADY_EXISTS",
  "message": "limit (search-svc, cust_42, requests_per_min) already exists; use UpdateLimit" }
```

**5 — Raise the override via `UpdateLimit`** (upsert with `create_if_absent`, §3.3).

```
PATCH /v1/limits
{ "key": { "...": "cust_42" }, "limit_value": 6000, "time_unit": "MINUTE", "create_if_absent": true }
→ 200 OK
{ "limit": { "key": { "...": "cust_42" }, "limit_value": 6000, "time_unit": "MINUTE", "config_id": 8121 } }
```

**6 — "What limit does this customer actually get?"** (`GetLimit`, `resolve=true`,
§3.5) — `cust_99` has no override, so the default answers.

```
GET /v1/limits:resolve?service_name=search-svc&customer_id=cust_99&rate_limit_id=requests_per_min
→ 200 OK
{ "limit": { "key": { "service_name": "search-svc", "customer_id": "*", "rate_limit_id": "requests_per_min" },
             "limit_value": 1000, "time_unit": "MINUTE", "config_id": 8120 },
  "is_default": true }
```

**7 — List a service's limits** (§3.5) — always scoped to one `service_name` (the RBAC boundary).

```
GET /v1/limits?service_name=search-svc&page_size=2
→ 200 OK
{ "limits": [
    { "key": { "customer_id": "*",       "...": "" }, "limit_value": 1000, "time_unit": "MINUTE", "config_id": 8120 },
    { "key": { "customer_id": "cust_42", "...": "" }, "limit_value": 6000, "time_unit": "MINUTE", "config_id": 8121 }
  ],
  "next_page_token": "" }
```

**8 — Validation failure → `INVALID_ARGUMENT`** with the offending `field` (§3.8).

```
POST /v1/limits
{ "key": { "service_name": "search-svc", "customer_id": "cust_7", "rate_limit_id": "requests_per_min" },
  "limit_value": -5, "time_unit": "MINUTE" }
→ 400 Bad Request
{ "code": 3, "status": "INVALID_ARGUMENT", "field": "limit_value", "message": "limit_value must be >= 0" }
```

**9 — RBAC denial → `PERMISSION_DENIED`** (§7) — a `billing-team` caller editing `search-svc`.

```
POST /v1/limits          (Authorization: Bearer <billing-team token>)
→ 403 Forbidden
{ "code": 7, "status": "PERMISSION_DENIED",
  "message": "identity 'billing-team' is not an editor of service 'search-svc'" }
```

**10 — Audit history for one limit** (`ListAuditEntries`, §3.9) — the before/after
of the raise in step 5, newest first.

```
GET /v1/audit?service_name=search-svc&config_id=8121
→ 200 OK
{ "entries": [
    { "audit_id": 40551, "config_id": 8121, "operation": "UPDATE",
      "old_row": { "limit_value": 5000, "time_unit": "MINUTE", "...": "" },
      "new_row": { "limit_value": 6000, "time_unit": "MINUTE", "...": "" },
      "changed_by": "alice@corp", "changed_at": "2026-07-12T14:05:11Z" },
    { "audit_id": 40120, "config_id": 8121, "operation": "INSERT",
      "old_row": null,
      "new_row": { "limit_value": 5000, "time_unit": "MINUTE", "...": "" },
      "changed_by": "alice@corp", "changed_at": "2026-07-12T13:40:02Z" }
  ],
  "next_page_token": "" }
```

**11 — Delete the override** (§3.4) — afterward `cust_42` falls back to the default.

```
DELETE /v1/limits   { "key": { "...": "cust_42" } }
→ 200 OK {}
# a subsequent GetLimit:resolve for cust_42 now returns the '*' default (is_default: true)
```

---

## 4. Data Model

`quotamgmt` owns the Postgres schema in `schema/postgres.sql` (parent Appendix
B.1). This section describes how the API uses it; it does not restate the DDL.

### 4.1 Tables (reference)

- **`service`** — registered producers; `service_name` PK, `owner` for RBAC.
- **`limit_config`** — the lean config table: `id`, `(service_name, customer_id,
  rate_limit_id)` unique, `limit_value`, `time_unit`. No region/enabled/timestamps
  (parent Appendix B.1).
- **`limit_config_audit`** — append-only history: `operation`, `old_row`,
  `new_row`, `changed_by`, `changed_at`. Doubles as the change-feed source (§5).

### 4.2 Resolution query (exact then default)

The data plane runs exactly this on a config-cache miss (parent §6.2; comment in
`schema/postgres.sql`). `quotamgmt` also runs it for `GetLimit(resolve=true)`:

```sql
SELECT id, limit_value, time_unit, customer_id
  FROM limit_config
 WHERE service_name = :svc
   AND rate_limit_id = :rlid
   AND customer_id IN (:cust, '*')      -- exact OR default
 ORDER BY (customer_id = '*')           -- FALSE (exact) sorts before TRUE (default)
 LIMIT 1;
```

- Returns the **exact** customer row if present, else the `'*'` **default**, else
  **no row** → unconfigured → allow (parent §9).
- Served by the `uq_limit` unique index and `idx_limit_service`. The `IN (:cust,
  '*')` touches at most two index entries; sub-millisecond.

### 4.3 Uniqueness, deletes, defaults

- **Uniqueness** is `(service_name, customer_id, rate_limit_id)` via `uq_limit`.
  There is exactly one row per tuple; `CreateLimit` maps to it directly and
  `ALREADY_EXISTS` is the constraint surfacing (§3.2).
- **Deletes** are hard row deletes (§3.4); fallback-to-default (or to
  unconfigured→allow) is a *resolution-time* effect, not stored state.
- **Defaults** are `customer_id = '*'` rows (§3.6); a service may have at most one
  default per `rate_limit_id` (same unique constraint, with `customer_id` fixed at
  `'*'`).

### 4.4 Audit write path (`SET LOCAL app.actor`)

Every mutation follows this transaction shape. The actor is threaded from the
authenticated caller (§7) into the session GUC; the trigger raises if it is unset
(parent Appendix B.1, `schema/postgres.sql` lines 66–94):

```sql
BEGIN;
  SET LOCAL app.actor = :actor;         -- e.g. 'alice@anthropic.com' or 'svc:search-svc-ci'
  INSERT INTO limit_config (service_name, customer_id, rate_limit_id, limit_value, time_unit)
  VALUES (:svc, :cust, :rlid, :val, :unit);
  -- AFTER-trigger writes limit_config_audit(operation=INSERT, old_row=NULL, new_row=NEW, changed_by=actor)
COMMIT;
```

- **`SET LOCAL`** scopes the GUC to the transaction, so a pooled connection never
  leaks one request's actor into the next (§9.1 covers pooling implications).
- The application **must not** write `limit_config_audit` itself — the trigger
  is the single writer, guaranteeing **audit completeness**: there is no code path
  that mutates config without an audit row (this is asserted as an SLO, §9-Obs).
- If `app.actor` is unset (a bug), the trigger raises and the **whole transaction
  aborts** — the config write fails closed *for the write path*. This does not
  affect enforcement (§1.2); it just means an unattributed change is impossible.

---

## 5. Config Propagation to the Data Plane

This is the heart of `quotamgmt`'s coupling to `quotaenforcer`. Config is written
rarely but must reach every region's local config cache promptly. Three
mechanisms compose: **watermark polling** (baseline, always on), **`LISTEN/NOTIFY`
push** (low-latency nudge), and **snapshot bootstrap** (cold start). This
realizes parent §12.4 and Appendix B.1 "Propagation".

### 5.1 Watermark polling (baseline)

Each `quotaenforcer` instance keeps a high-water mark `last_seen` (a
`changed_at` value) and periodically asks:

```sql
SELECT audit_id, config_id, operation, old_row, new_row, changed_at
  FROM limit_config_audit
 WHERE changed_at > :last_seen
 ORDER BY changed_at, audit_id
 LIMIT :batch;
```

Served by `idx_audit_changed_at` (parent Appendix B.1). For each returned row the
data plane applies the change to its local cache by `config_id`:

- `INSERT`/`UPDATE` → upsert the resolved `(service, customer, rate_limit_id) →
  {limit_value, time_unit}` into cache (invalidate any negative-cache entry for
  that tuple).
- `DELETE` → evict the tuple; the next resolution re-runs §4.2 (falling back to
  default or unconfigured→allow).

Then advance `last_seen` to the max `changed_at` consumed.

> **Watermark correctness — the `changed_at` tie hazard.** `changed_at` is
> `TIMESTAMPTZ DEFAULT now()`, and `now()` is the *transaction start time*, so two
> rows committed in the same transaction (or at the same clock tick) can share a
> `changed_at`. Using strict `>` could **skip** a row that shares the boundary
> timestamp with one already consumed. Mitigations, in order of robustness:
> 1. **Overlap the window:** poll `changed_at >= :last_seen - epsilon` (a few
>    seconds) and **dedup by `audit_id`**. Reapplying a change is idempotent (it is
>    an upsert/evict by `config_id`), so overlap is safe and cheap.
> 2. Track the watermark as the composite `(changed_at, audit_id)` and use a
>    row-value comparison `(changed_at, audit_id) > (:ts, :id)`.
> We adopt (1) as the baseline — idempotent apply makes overlap the simplest
> correct choice — and note (2) as a tightening if the overlap window ever costs
> too much scan.

- **Poll interval:** short (e.g. 1–5 s). Writes are rare (parent §12.4), so most
  polls return zero rows and cost one indexed range scan.
- **Jitter** the interval per instance so N enforcer instances don't stampede the
  DB in lockstep (parent §12.3, §12.4).
- Polling is the **floor on staleness** and the fallback when NOTIFY is missed
  (§5.2). It is also the mechanism that makes the system self-heal after any
  push-delivery gap.

### 5.2 `LISTEN/NOTIFY` push (latency nudge)

To cut propagation latency below the poll interval, `quotamgmt` (or the audit
trigger) issues `pg_notify('limit_config_changed', payload)` on commit, where
`payload` carries the `config_id` and `changed_at`. Each `quotaenforcer` instance
holds a `LISTEN limit_config_changed` connection and, on notification, performs an
**immediate** incremental poll (§5.1) rather than trusting the payload alone.

- **NOTIFY is a hint, not the source of truth.** It can be dropped (listener
  reconnect, queue overflow, instance restart between commit and delivery). That is
  fine: the periodic watermark poll (§5.1) is the safety net and will pick up
  anything a NOTIFY missed within one poll interval.
- **Regional fan-out:** `LISTEN/NOTIFY` is delivered by the Postgres instance the
  listener connects to. With per-region read replicas (§9.2), NOTIFY must reach
  listeners in every region. Two options: (a) enforcers `LISTEN` on the regional
  replica **if** the replication stream carries the notification (implementation-
  dependent), or (b) a thin **relay** in `quotamgmt` that listens on the primary
  and re-publishes regionally. We default to **(b)** — a relay is explicit and does
  not depend on replica NOTIFY semantics — and fall back to poll-only if the relay
  is down. Either way, correctness never depends on NOTIFY.

> **Trade-off — why keep polling if we have NOTIFY?** NOTIFY alone has no
> redelivery and no cold-start story. Polling alone has latency floored at the
> interval. Together: NOTIFY gives the common-case low latency, polling gives the
> correctness guarantee and recovery. This is the standard "push for speed, pull
> for truth" pattern and matches parent §12.4's "push invalidation … instead of
> pure TTL expiry."

### 5.3 Snapshot bootstrap (cold data-plane instance)

A freshly started `quotaenforcer` instance has an empty cache and no useful
`last_seen`. Rather than replaying the entire audit log from the beginning of
time, it **bootstraps from a snapshot**:

1. Open a `REPEATABLE READ` (or serializable snapshot) transaction so the config
   read and the watermark read see the same instant.
2. Read the current config set (scoped to the region's relevant services), e.g.
   `SELECT service_name, customer_id, rate_limit_id, limit_value, time_unit FROM
   limit_config;` — small (rare writes, modest tenant count), so a full scan is
   fine.
3. In the **same snapshot**, read `SELECT max(changed_at) FROM limit_config_audit`
   and set `last_seen` to it.
4. Close the transaction; begin incremental polling (§5.1) from `last_seen`.

Taking config and watermark from one MVCC snapshot guarantees no change is
**lost** (missed between snapshot and first poll) or **double-applied** in a way
that matters (apply is idempotent anyway). For very large config sets, the
snapshot can be served from a **read replica** (§9.2) and/or cached as a periodic
materialized dump that instances pull from object storage, with the watermark
stored alongside — parent §12.4 mentions "periodic full reload is viable since
writes are rare," and this is its concrete form.

### 5.4 Propagation SLA and stale-read behavior

- **Target:** a committed config change is reflected in every in-region
  `quotaenforcer` cache within **≤ 5 s p99** (NOTIFY path typically ≤ 1 s;
  poll-only fallback bounded by the poll interval + one query). This is the
  **propagation-lag SLO** and is measured end-to-end (§9-Obs). Parent §18
  decision 3 fixes this number at ≤ 5 s; we commit to it as the default and make it
  tunable via poll interval.
- **Stale reads fail open, never closed.** While a change is in flight, the data
  plane serves the **last-known-good** cached config (parent §9 "Config lookup
  fails → serve last-known-good; if none, allow"). Concretely:
  - A **raised** limit propagating slowly → the customer is briefly held to the
    old, lower cap. Mildly conservative, self-corrects within the SLA.
  - A **lowered** limit propagating slowly → the customer briefly keeps the old,
    higher cap. Slightly permissive, self-corrects within the SLA. Given windows
    are minute+ and writes rare, the overshoot is negligible and consistent with
    the approximate-accuracy stance (parent §1.2, §6.4).
  - A **new/deleted** row propagating slowly → resolves against the pre-change
    state; a not-yet-seen limit means unconfigured → **allow** (fail-open), never
    a spurious deny.

The invariant: **propagation lag can only make enforcement more permissive for a
bounded window; it can never cause a wrong deny or block the product.**

---

## 6. Consistency & Concurrency

- **Strong consistency at the source of truth.** All writes go to the Postgres
  **primary** in a single transaction (§4.4). Postgres gives ACID + strong
  consistency, so there is no read-modify-write anomaly within a write.
- **Last-writer-wins, no CAS.** There is deliberately no optimistic-concurrency /
  `version` column (parent §17, Appendix B.1). Config writes are rare (per
  service/customer/limit) and target distinct rows; genuine concurrent edits of
  the **same** row are exceptional. When they do collide, Postgres serializes them
  and the later commit wins. Both edits appear in `limit_config_audit`, so "who
  clobbered whom" is always answerable — the audit trail is the concurrency
  safety net in lieu of CAS.
- **Serialization failures.** Under `READ COMMITTED` (the default) a plain
  single-row `UPDATE` blocks then proceeds; no explicit retry needed. If a future
  operation batches multiple rows under a stricter isolation level and hits a
  serialization failure, the API returns `ABORTED` and the client may retry
  (§3.10) — a rare, benign path given the write rate.
- **Read-your-writes for the caller.** After a successful `CreateLimit`/`Update`,
  a `GetLimit` against the **primary** reflects it immediately. `ListLimits` from a
  **read replica** (§9.2) may lag by replication delay (sub-second typically); the
  API can route a caller's immediate post-write read to the primary if
  read-your-writes matters for that flow (e.g. `quotaui` showing the row it just
  saved).
- **Cross-region consistency** is *eventual* by design (parent §11): the primary
  is authoritative; replicas and remote regions converge via replication (§9.3).
  This is acceptable because the data plane already tolerates propagation lag
  fail-open (§5.4).

---

## 7. Auth & Multi-Tenancy

`quotamgmt` is a privileged, multi-tenant admin surface. Its authZ model ties
directly to parent §16 ("a producer may only read/write its own `service_name`'s
limits") and §5.1 (the UI's SSO + RBAC).

### 7.1 Identity

| Caller | AuthN | Identity used |
|--------|-------|---------------|
| `quotaui` | SSO (OIDC); user session | the signed-in **user** (`alice@anthropic.com`) |
| Programmatic client | **mTLS / service identity** (parent §16) | the calling **service** (`svc:search-svc-ci`) |
| Platform admin tooling | SSO + elevated role | the **operator** identity |

The resolved principal becomes the **audit actor** (§7.3). No RPC is anonymous;
missing/invalid identity → `UNAUTHENTICATED`.

### 7.2 RBAC scoping

Authorization is **per `service_name`**. Roles:

| Role | Scope | May do |
|------|-------|--------|
| `service-editor` | one or more `service_name`s (granted via the service's `owner`, §3.7) | CRUD limits (incl. defaults) for those services; read their audit. |
| `service-viewer` | one or more `service_name`s | `GetLimit`/`ListLimits`/`ListAuditEntries` only. |
| `platform-admin` | all services | everything above + `RegisterService`; break-glass edits (still audited). |

- **Enforcement:** every RPC carries a target `service_name`; the server checks
  the principal's grants for it **before** touching the DB. A `service-editor` for
  `search-svc` calling `UpdateLimit` on `chat-svc` gets `PERMISSION_DENIED`
  (§3.10). This is the concrete form of parent §16's "producer may only read/write
  its own service's limits."
- **Default-row edits** require `service-editor` on that service; because a `'*'`
  delete is high-blast-radius (§3.4), `quotaui` additionally enforces
  confirmation / two-person review at the UX layer (parent §5.1) — but the API
  authorization is the same role.
- Grants themselves live in the platform's identity system (out of scope here);
  `quotamgmt` consumes them, it does not administer them.

### 7.3 Actor attribution into the audit trail

The authenticated principal (§7.1) is written as `SET LOCAL app.actor` on the
**same transaction** as the mutation (§4.4). Thus:

- A `quotaui` change is attributed to the human (`alice@anthropic.com`).
- A programmatic change is attributed to the service (`svc:search-svc-ci`).
- A break-glass admin change is attributed to the operator.

The trigger's raise-if-unset rule (parent Appendix B.1) means **no mutation can
be unattributed** — a hard guarantee, not a convention. This backs `quotaui`'s
"who lowered it last Tuesday?" view (parent §5.1) and the audit-completeness SLO
(§9-Obs).

### 7.4 Admin-tier abuse protection

Even though QPS is low, a runaway script could hammer the API. A coarse per-
principal admin rate limit (e.g. a few hundred writes/min) returns
`RESOURCE_EXHAUSTED` (§3.10) beyond threshold. This protects Postgres and the
change-feed from a config-write storm (which would also flood the audit table and
NOTIFY channel). Note the pleasing recursion — the rate limiter's own control
plane is itself rate-limited — but this is a simple static guard, not a
`quotaenforcer` dependency (no hot-path coupling).

---

## 8. Failure Handling

**Guiding principle (inherited from parent §9):** `quotamgmt` being unavailable
must **never** block enforcement. The data plane serves cached config and
ultimately fails open. This section makes that concrete.

| Failure | `quotamgmt` behavior | Effect on enforcement (`quotaenforcer`) |
|---------|----------------------|------------------------------------------|
| **`quotamgmt` API tier down** | No CRUD; `quotaui`/scripts see errors. | **None.** Data plane runs on cached config; change-feed simply has no new changes to deliver. |
| **Postgres primary down (writes)** | Writes fail with `UNAVAILABLE` (§3.10). | **None.** No new config to propagate; existing cache stands. |
| **Postgres primary failover** | Brief write outage until a replica is promoted; async replication may lose the last few committed writes (parent §7.3 accepts this for the counter path; here it means the last one or two config edits may need re-applying). | **None** during; after promotion, propagation resumes from the change-feed. A lost write is simply re-issued by the operator (idempotent create/update). |
| **Read replica down (reads)** | `GetLimit`/`ListLimits` fail over to the primary or another replica; slightly higher primary load. | **None.** |
| **Change-feed / NOTIFY relay down** | Push nudges stop. | Data plane **falls back to watermark polling** (§5.1); propagation latency rises to the poll interval but stays within a looser SLA. Self-heals when the relay returns. |
| **Config-cache miss at the data plane while Postgres unreachable** | n/a (data-plane concern) | Serve last-known-good; if none for that tuple, **allow** (parent §6.2, §9). |
| **Corrupt/rejected write (validation, FK, unique)** | Typed 4xx (§3.10); nothing written, nothing propagated. | **None.** |

Why this holds structurally: `quotaenforcer` **never synchronously depends on
`quotamgmt` or Postgres in the request path** (parent §1.2, §6.2). The only
coupling is the asynchronous change-feed, whose worst-case failure is *stale
config served fail-open* (§5.4). There is no failure of `quotamgmt` that turns
into a consumer-facing `429` or a product outage.

> **Degraded-write acceptance.** During a Postgres primary outage the control
> plane is effectively read-only (from replicas) and cannot accept config edits.
> This is acceptable: config changes are rare and rarely urgent, and the one
> genuinely urgent case — needing to *loosen* a limit to unblock a customer —
> still can't make things worse than fail-open, since an unreachable-config
> resolution already allows. We do **not** add a write-ahead queue or secondary
> write store; the added complexity isn't justified by the rare, non-urgent write
> pattern.

---

## 9. Deployment & Scaling

### 9.1 Stateless API tier

- `quotamgmt` is a **stateless** gRPC/HTTP service, autoscaled behind a load
  balancer, mirroring the data-plane service tier's statelessness (parent §5).
  All state is in Postgres; any instance can serve any request.
- **Connection pooling.** Because `SET LOCAL app.actor` is transaction-scoped
  (§4.4), pooled connections are safe — the GUC never outlives its transaction.
  We front Postgres with a pooler (e.g. PgBouncer in **transaction** pooling mode,
  which is compatible with `SET LOCAL` but **not** with session-level `SET`; this
  is a deliberate reason we use `SET LOCAL`). Pool sizes are small — write QPS is
  tiny (parent §12.4).
- **Idempotency of writes.** `CreateLimit` is naturally idempotent-ish via
  `ALREADY_EXISTS`; `UpdateLimit`/`DeleteLimit` are idempotent by value. Clients
  may safely retry on `UNAVAILABLE`/`ABORTED`.

### 9.2 Postgres topology: primary + read replicas

- **One primary** takes all writes (the source of truth). **Read replicas** serve
  `ListLimits`, `ListAuditEntries`, and the snapshot bootstrap (§5.3) — none of
  which need the absolute latest write.
- **Write vs. read routing** is explicit in the service: mutations and
  read-your-writes go to the primary; bulk/admin reads and cold-start snapshots go
  to a replica. This is the parent's §18 decision 6 direction (read replicas
  to reduce config-DB load, future work), realized on the control-plane side.
- The **change-feed** (§5) polls the audit table; it can read from a **regional
  replica** to keep cross-region poll traffic off the primary, accepting that a
  replica's few-hundred-ms lag adds to propagation lag (still within the ≤ 5 s
  SLA, §5.4).

### 9.3 Global replication topology

- Per the parent's regional model (§11), there is **one data-plane deployment per
  region**, and **config replicates globally** so a limit created anywhere is
  enforced everywhere.
- Concretely: a **single writable primary** (in a home region) with **streaming
  read replicas in every region**. Each region's `quotaenforcer` fleet consumes
  the change-feed from its **local replica** (low-latency polls) while all writes
  funnel to the one primary via `quotamgmt`.
- This is a classic single-writer / multi-region-reader topology. It fits because
  writes are rare and globally infrequent, so a single primary is not a throughput
  bottleneck, and it sidesteps multi-primary conflict resolution entirely
  (consistent with "no CAS / last-writer-wins," §6). Cross-region write latency
  (an operator in a far region editing config) is irrelevant at this QPS.

### 9.4 Scale characteristics

- **QPS:** writes are very low (config changes are human/CI-paced); reads are
  low-to-moderate (admin browsing + change-feed polls × enforcer instance count).
  The change-feed poll volume is `#enforcer_instances / poll_interval`, absorbed
  by the `idx_audit_changed_at` index and replicas.
- **Data size:** `limit_config` is small (one row per configured tuple);
  `limit_config_audit` grows monotonically but slowly (one row per change). A
  retention/rollup policy for very old audit rows can be added later (§10); it does
  not affect the change-feed, which only ever queries the recent tail.

---

## 10. Observability

Ties into the parent's observability section (§15), which already lists
"config-propagation lag" and "config-change rate" as signals. `quotamgmt` owns
their production.

| Signal | What / why | Type |
|--------|-----------|------|
| **Config change rate** | INSERT/UPDATE/DELETE per minute per service. A spike may indicate a misbehaving script (see §7.4) or a bulk migration. | counter |
| **Propagation lag (key SLO)** | End-to-end time from `changed_at` (commit) to the change being reflected in a data-plane cache. Measured by a synthetic canary limit edited on a schedule and observed via the enforcer's cache/read path. **SLO: ≤ 5 s p99** (§5.4). | histogram |
| **Change-feed poll health** | Poll QPS, rows returned per poll, watermark age per enforcer instance, NOTIFY delivery count vs. poll-detected changes (gap = missed NOTIFYs, expected to be small). | gauges/counters |
| **API error rates** | Per-code (§3.10) rate: `INVALID_ARGUMENT` (client bugs), `PERMISSION_DENIED` (authz misconfig or probing), `UNAVAILABLE` (Postgres health). | counter by code |
| **API latency** | p50/p99 of each RPC. Not latency-critical, but a regression flags DB/pool trouble. | histogram |
| **Audit completeness** | Assert **#config mutations == #audit rows** — reconcilable because the trigger is the sole audit writer (§4.4). A mismatch (should be impossible) is a P1: it means an unaudited write path exists. Monitored by periodic reconciliation and by alerting on any trigger-disabled event. | invariant check |
| **Postgres health** | Replication lag (primary→replica, feeds propagation lag), connection-pool saturation, primary failover events. | gauges |

**Alerts:** propagation lag over SLO; change-feed watermark stalled (an instance
stopped consuming); `UNAVAILABLE` rate (primary trouble); any audit-completeness
mismatch; replication lag high (parent §15 already alerts on "config-propagation
lag" and "replication lag").

---

## 11. Testing & Rollout

### 11.1 Testing

- **Schema/trigger tests.** Assert the audit trigger fires for INSERT/UPDATE/DELETE
  with correct `old_row`/`new_row`, and that a write with **no** `app.actor`
  **raises** (the fail-closed-for-writes guarantee, §4.4). Assert `uq_limit` and
  the `limit_value >= 0` check.
- **Resolution query tests.** Exact-wins-over-default, default-fallback,
  no-row→unconfigured, `limit_value = 0`→deny-all (all §4.2, §3.8). Property-test
  that `GetLimit(resolve=true)` matches what the data plane's §6.2 query returns
  for the same fixtures.
- **API contract tests.** Every error code path in §3.10 (validation, FK,
  unique, authz scope, not-found vs. allow_missing/create_if_absent).
- **AuthZ tests.** `service-editor` on service A cannot touch service B;
  `service-viewer` cannot write; `platform-admin` can register services. Actor
  attribution lands the right principal in `changed_by` (§7.3).
- **Change-feed tests.** The `changed_at` tie hazard (§5.1): two audit rows with
  identical `changed_at` are both delivered (overlap + dedup). NOTIFY-dropped →
  poll recovers. Snapshot bootstrap consistency: no change lost across
  snapshot→first-poll under concurrent writes (§5.3).
- **Propagation SLA test.** A staging harness edits a canary limit and measures
  end-to-end lag against the ≤ 5 s SLO (§5.4, §10), including the NOTIFY-relay-down
  fallback-to-poll path.
- **Failover tests.** Kill the Postgres primary mid-write (expect `UNAVAILABLE`,
  no partial audit); confirm enforcement is unaffected throughout (§8).

### 11.2 Rollout

Fits into the parent's rollout plan (§19), whose step 1 is "control plane +
config API." Concretely for `quotamgmt`:

1. **Schema + trigger** deployed (`schema/postgres.sql`); primary + one replica.
2. **API tier** with CRUD + validation + authZ, behind SSO/mTLS; `quotaui` and
   programmatic clients integrated read-only first, then read-write.
3. **Change-feed**: enable watermark polling in `quotaenforcer`; validate
   propagation lag in staging; then enable NOTIFY push + relay.
4. **Snapshot bootstrap** for cold enforcer instances; verify under scale-up.
5. **Multi-region**: add regional read replicas; point each region's enforcer
   fleet at its local replica's feed (§9.3).
6. **Hardening**: audit-completeness reconciliation job, admin-tier rate limit
   (§7.4), audit retention/rollup policy (§9.4).

Because `quotamgmt` is off the hot path, its rollout carries **no
consumer-facing risk** — a bug delays or blocks *config edits*, never
enforcement, which continues on cached config and fails open.

---

## 12. Cross-References

- **Parent** [`regional-rate-limiter-design.md`](../regional-rate-limiter-design.md):
  §3.3 (control-plane API surface), §4.1 (config model), §5 & §5.1 (architecture,
  Admin UI), §6.2 (resolution + two-absences), §9 (fail-open), §11 (regional
  model), §12.4 (cache/propagation), §16 (multi-tenancy), §17 (trade-offs), §18
  (resolved decisions), Appendix B.1 (Postgres schema).
- **Schema:** `schema/postgres.sql` — the DDL, trigger, and resolution query this
  doc operates on.
- **Siblings:** `quotaenforcer` (data plane — consumes the change-feed §5,
  resolves limits per parent §6.2, owns Redis counters); `quotaui` (admin UI —
  a `quotamgmt` client per §7.1, adds SSO/RBAC UX, live-usage via the enforcer
  read API not `quotamgmt`).
