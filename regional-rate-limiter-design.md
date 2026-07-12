# Design Doc: Regional Rate Limiting Service

**Status:** Draft
**Author:** chengliangzhang@gmail.com
**Date:** 2026-07-12

---

## 1. Overview

Anthropic needs a general-purpose, regional rate limiting service that its
internal service producers can use to enforce per-customer quotas. The goal is
fairness across customers and protection of shared, finite resources against
both accidental and intentional abuse.

This document proposes a design. It does **not** cover implementation.

### 1.1 Goals

- A shared service that any producer can integrate with minimal effort.
- Configurable quotas keyed by `(service_name, customer_id, rate_limit_id)`.
- Support for `check`, `charge`, and `refund` operations.
- Reset windows of `minute`, `day`, or `month`.
- Meet the non-functional bar: low latency, scalable, highly available,
  **fail-open**, graceful error handling, predictable degradation, low cost.

### 1.2 Non-Goals

- **Strict, globally-consistent quota enforcement across regions.** We enforce
  per-region (see §11). Exact global caps require cross-region coordination that
  conflicts with latency and availability goals.
- **Perfect accuracy under concurrency.** The check/charge split is inherently
  optimistic; overshoot into negative quota is an accepted, bounded outcome
  (this is by design — see §6.4).
- Billing/metering. We track quota, not money. Producers may feed our counters
  into billing, but that is out of scope.
- Being the authorization layer. We answer "is there quota?", not "is this
  caller allowed?".

---

## 2. Requirements

### 2.1 Functional

| # | Requirement |
|---|-------------|
| F1 | Producers can CRUD rate-limit configs: `(service_name, customer_id, rate_limit_id)` → `{ limit: int, unit: minute\|day\|month }`, including a per-`(service, rate_limit_id)` **default** (`customer_id = '*'`) applied when a customer has no explicit override. |
| F2 | `Check(key, cost)` returns allow/deny. Deny surfaces as HTTP `429` to the end consumer. |
| F3 | `Charge(key, cost)` is applied **after** the request is processed. It always succeeds and may drive quota negative. Returns remaining quota. |
| F4 | `Refund(key, amount)` returns quota to the bucket, capped at the configured limit. |
| F5 | Quota resets on a fixed schedule per the configured time unit. |

### 2.2 Non-Functional

| # | Requirement | Design implication |
|---|-------------|--------------------|
| N1 | **Low latency** | In-region, in-memory counters; single round trip; p99 budget ≤ 5 ms. |
| N2 | **Scalable** | Sharded counter store; horizontal stateless API tier. |
| N3 | **High availability** | Replication, no single point of failure, multi-AZ. |
| N4 | **Fail-open** | On any RL failure/timeout, the producer **allows** the request. |
| N5 | **Graceful errors** | Well-typed errors; client SDK never throws into the request path. |
| N6 | **Predictable degradation** | Load-shed, bounded staleness, documented accuracy loss under stress. |
| N7 | **Low cost** | Small keys, TTL-bounded memory, request batching/coalescing. |

The tension worth stating up front: **N1/N3/N4 (latency, availability,
fail-open) beat strict correctness.** When forced to choose, we let a request
through rather than add latency or fail closed. A rate limiter must never be the
reason the product is down.

---

## 3. API Design

Two planes: a **control plane** (config, low QPS) and a **data plane**
(check/charge/refund, very high QPS).

### 3.1 Data plane

All keys are the tuple `(service_name, customer_id, rate_limit_id)`.

```
CheckQuota(key, cost=1) -> { allowed: bool, remaining: int, limit: int, reset_at: ts }
Charge(key, cost, request_id) -> { remaining: int, limit: int, reset_at: ts }
Refund(key, amount, request_id) -> { remaining: int, limit: int, reset_at: ts }
```

- `cost` defaults to 1 but supports weighted requests (e.g. a large request
  costs more).
- `request_id` is an opaque id carried for **logging/tracing/debugging** only
  (see §7.2). It is **not** used for server-side dedup.
- Batch variants (`CheckQuotaBatch`, `ChargeBatch`) let a producer touch
  multiple keys in one round trip (e.g. a per-customer *and* a per-org limit).

Transport: **gRPC** (low overhead, streaming, native deadlines) with an HTTP/JSON
gateway for non-gRPC callers.

### 3.2 Typical producer flow

```
1. CheckQuota(key)              -> if !allowed: return 429 to consumer, stop.
2. ... process the request ...
3. Charge(key, actual_cost, request_id)   // fire-and-forget acceptable
4. (on downstream failure) Refund(key, actual_cost, request_id)
```

`Check` is advisory and does **not** reserve. `Charge` is the source of truth.
This is deliberate: it keeps the hot pre-flight check cheap and lets the real
cost (often unknown until after processing) be charged accurately.

### 3.3 Control plane

```
CreateLimit / UpdateLimit / DeleteLimit / GetLimit / ListLimits
```

Config lives in a durable, replicated store (see §5) and is the source of truth
for `{limit, unit}`. Data-plane nodes cache config with a short TTL + change
notifications. These same APIs back the **Internal Admin UI** (§5.1) and any
programmatic callers.

---

## 4. Data Model

> Conceptual view below; concrete Postgres DDL and Redis key/Lua schemas are in
> **Appendix B**.

### 4.1 Config (control plane)

```
LimitConfig {
  service_name   string
  customer_id    string
  rate_limit_id  string
  limit          int64        // the cap
  unit           enum(MINUTE, DAY, MONTH)
}
```

### 4.2 Counter (data plane)

We store **consumed**, not remaining. Absence of a counter key = zero consumed =
full quota *for that window*, which avoids an initialization step and makes
resets free (the key just expires). Note this is **not** a signal about whether
the customer is known — the cap always comes from config (§6.2), never from
Redis; a missing counter just means this window hasn't been touched yet.

```
counter_key = "{service}:{customer}:{rate_limit_id}:{window_id}"
value       = consumed (int64)
TTL         = time until window end + grace + rand(0, J)   // jittered, see §12.1

remaining   = limit - consumed          // may be negative
```

`window_id` is derived from the current time and unit (see §6.1). When the
window rolls over, `window_id` changes, the old key expires, and the new key
starts at zero. **Reset is implicit** — no sweeper job.

---

## 5. High-Level Architecture

```
                        ┌─────────────────────────────────────┐
                        │           Producer Service          │
                        │  ┌───────────────────────────────┐  │
   consumer request ───▶│  │  Rate Limiter Client SDK      │  │
                        │  │  - local config cache         │  │
                        │  │  - deadline (≤5ms) + breaker  │  │
                        │  │  - fail-open logic            │  │
                        │  │  - (optional) token lease     │  │
                        │  └──────────────┬────────────────┘  │
                        └─────────────────┼───────────────────┘
                                          │ gRPC (in-region)
                                          ▼
                        ┌─────────────────────────────────────┐
                        │   Rate Limiter Service (stateless)   │  ← autoscaled
                        │   - request validation               │
                        │   - config lookup (cached)           │
                        │   - shard routing                    │
                        │   - Lua/atomic op dispatch           │
                        └─────────────────┬───────────────────┘
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                     ▼
              ┌────────────┐       ┌────────────┐       ┌────────────┐
              │ Counter    │       │ Counter    │  ...  │ Counter    │   Redis-
              │ shard 0    │       │ shard 1    │       │ shard N    │   compatible
              │ (primary + │       │ (primary + │       │ (primary + │   in-memory
              │  replica)  │       │  replica)  │       │  replica)  │   cluster
              └────────────┘       └────────────┘       └────────────┘
                                          ▲
                                          │ config feed (cache refresh)
                        ┌─────────────────┴───────────────────┐
                        │  Control-Plane API (stateless)       │
                        │  - CRUD limits / defaults / services │
                        │  - audited writes (SET app.actor)    │
                        │  - live-usage reads (via RL Service) │
                        └───────┬──────────────────────┬───────┘
                                │                      │
                                ▼                      ▼
                 ┌───────────────────────┐   ┌───────────────────────┐
                 │  Postgres (config +   │   │   Internal Admin UI   │
                 │  audit; source of     │◀──│  operators / service  │
                 │  truth, replicated)   │   │  owners — SSO + RBAC  │
                 └───────────────────────┘   └───────────────────────┘
```

**Components**

1. **Client SDK** (in-process in each producer). Owns the deadline, circuit
   breaker, fail-open decision, and config cache. This is where latency and
   availability guarantees are actually enforced.
2. **Rate Limiter Service** — stateless, horizontally scalable API tier.
   Validates, resolves config, routes to the correct shard, runs the atomic op.
   Stateless so it can be autoscaled and killed freely.
3. **Counter store** — a sharded, replicated, in-memory store with atomic
   operations and TTLs. Redis (or a Redis-compatible engine) is the baseline
   choice: single-threaded per shard gives us atomicity for free, `INCRBY`/Lua
   scripts, and native TTL.
4. **Control plane** — the **Control-Plane API** (stateless CRUD service) plus
   its **Postgres** config/audit store (§4.1, Appendix B.1). Low QPS, strongly
   consistent, **not in the hot path**.
5. **Internal Admin UI** — the human interface to the control plane, used by
   platform operators and service owners. Detailed in §5.1.

Everything in the data path is **regional**. The control plane replicates
globally so a config created anywhere is enforced everywhere.

### 5.1 Internal Admin UI

A web console for the people who operate the limiter — **platform operators**
(on-call, support) and **service owners** (producers who set their customers'
limits). It is a **control-plane client only**: it never sits in the data path,
so if the UI is down, enforcement is completely unaffected.

**What it does**

- **Config management** — CRUD rate limits for a `(service, customer,
  rate_limit_id)`, manage the `'*'` **default** rows (§6.2), and register
  services. All writes go through the Control-Plane API, which is the same
  audited path described in Appendix B.1.
- **Live usage inspection** — look up a customer's current `consumed` /
  `remaining` and `reset_at` for a given limit and window. The UI reads this
  from the **RL Service's read API** (which fronts Redis), never by talking to
  Redis directly.
- **Manual operations** — adjust a limit, issue a **refund/credit**, or reset a
  customer's window (e.g. to unblock someone throttled by a mistake). These map
  onto the existing `Refund` / config APIs; no special backdoor.
- **Audit & history** — browse `limit_config_audit`: who changed what, when, and
  the before/after values (Appendix B.1). Answers "why is this customer's limit
  X?" and "who lowered it last Tuesday?".
- **Observability** — surface throttle rate, fail-open rate, top-throttled
  customers, and hot keys (§15), either embedded or linked to dashboards.

**How it fits**

```
Admin UI ──HTTPS (SSO)──▶ Control-Plane API ──┬──▶ Postgres        (config + audit writes/reads)
                                              └──▶ RL Service read API ──▶ Redis  (live usage, read-only)
```

- **Auth & safety** — SSO for identity; **RBAC** scopes who may edit which
  service's limits (ties to the multi-tenant authz in §16). The signed-in user
  is threaded into `SET LOCAL app.actor` so every change is attributed in the
  audit trail. Read-only vs. editor roles; destructive actions (delete, reset)
  can require confirmation / two-person review.
- **Not in the hot path** — purely control-plane and low-QPS; its availability,
  latency, and correctness have **no bearing** on the request-time
  check/charge/refund path.

---

## 6. Core Algorithm

### 6.1 Windows & reset

Fixed-window counters. `window_id` is computed from the wall clock aligned to
the unit boundary in **UTC**:

- `MINUTE` → aligned to the start of the minute; TTL ≈ 60 s.
- `DAY` → aligned to 00:00:00 UTC; TTL until next midnight.
- `MONTH` → aligned to the 1st of the month 00:00 UTC; TTL until the 1st of next
  month (calendar-aware, since months vary in length — **not** a fixed second
  count).

Alignment via `window_id` means every node computes the same key from the same
clock without coordination. Clock skew between nodes only matters at the
boundary and is bounded by NTP (< 100 ms), which is negligible for minute+ windows.

**Known limitation:** fixed windows allow up to ~2× the limit across a boundary
(burst at :59 + burst at :00). We accept this in exchange for an O(1)-memory,
predictable, cheap counter. (Sliding windows would smooth the burst at higher
memory/CPU cost; explicitly out of scope — see §17.)

### 6.2 Resolving the applicable limit (config lookup)

Before any check/charge, the service needs the **cap** for
`(service_name, customer_id, rate_limit_id)`. The cap lives in **Postgres**, not
Redis — a Redis counter only ever holds `consumed`. So every request first
resolves the limit from config, then does the counter op with that limit passed
in as an argument.

**Two independent "absences" that must not be confused:**

- **Missing Redis counter key** → the customer simply hasn't used this
  *window* yet. It means `consumed = 0` (full quota), **not** "unknown
  customer." The limit still comes from config as usual.
- **Missing local config-cache entry** → this instance hasn't seen this
  `(service, customer, rate_limit_id)` yet (a cold customer). *This* is when we
  read from the DB.

**Read-through resolution** (local cache → Postgres), with **default-limit
fallback**:

```
limit = configCache.get(service, customer, rate_limit_id)
if limit is MISS:
    limit = SELECT ... FROM limit_config
            WHERE service_name=? AND rate_limit_id=?
              AND customer_id IN (?, '*')            -- exact OR default
            ORDER BY (customer_id = '*')             -- exact wins over default
            LIMIT 1
    configCache.put(..., limit, ttl=jittered)        -- incl. negative cache
```

- A row with `customer_id = '*'` is the **per-`(service, rate_limit_id)` default**
  that applies to any customer without an explicit override. Exact
  customer rows win over the default.
- **No row at all** (neither exact nor `'*'`) → the limit is *unconfigured*.
  Consistent with fail-open (§9), we **allow** (treat as unlimited) and **cache
  that negative result briefly** so a cold/unknown customer can't stampede
  Postgres (§12.4).
- Config reads are cheap and rare relative to data-plane QPS; the local cache
  absorbs nearly all of them, refreshed via the audit change-feed (§12.4). An
  optional shared (Redis) config cache can sit between the instances and Postgres
  if per-instance cold-start load ever matters.

### 6.3 Check

```
limit     = resolveLimit(service, customer, rate_limit_id)   // §6.2 (config, not Redis)
consumed  = GET counter_key            // missing => 0 (fresh window, not unknown)
remaining = limit - consumed
allowed   = remaining >= cost
return { allowed, remaining, limit, reset_at }
```

Read-only, no mutation. Cheap and cacheable for a few hundred ms on hot keys.

### 6.4 Charge (atomic, via Lua)

```
new_consumed = INCRBY(counter_key, cost)
if TTL(counter_key) not set: EXPIRE(counter_key, window_remaining + grace + rand(0,J))  // §12.1
return { remaining: limit - new_consumed, ... }   // may be negative
```

Charge **always** applies and can push `remaining` negative. This is the
specified behavior and the natural consequence of a non-reserving `Check`:
between check and charge, N concurrent requests can each pass the check and then
all charge, overshooting the cap. The overshoot is bounded by concurrency, the
bucket goes negative, and **subsequent checks correctly deny** until the window
resets. We accept transient overshoot in exchange for a cheap, low-latency
pre-flight check. Producers who need hard caps can charge-then-check instead
(reserve up front) at the cost of needing compensating refunds.

### 6.5 Refund (atomic, via Lua)

```
new_consumed = DECRBY(counter_key, amount)
if new_consumed < 0: SET(counter_key, 0)      // never credit above the cap
return { remaining: limit - new_consumed, ... }
```

Refund is floored so consumed never goes below zero (remaining never exceeds the
cap). **Edge case:** a refund arriving after the window it belongs to has reset
would credit the *new* window. We treat refunds as best-effort and
window-scoped; a refund for an expired window is a no-op-ish over-credit that the
floor bounds. Acceptable given windows are short relative to request lifetimes;
for the month window this over-credit is explicitly accepted, not fixed
(§18, decision 1).

### 6.6 Why Lua / server-side atomicity

Each `charge`/`refund` is a read-modify-write that must be atomic. Running it as
a single Lua script (or `INCRBY` + conditional) on the shard that owns the key
gives atomicity without distributed locks. Because a key lives on exactly one
shard (§10), there is no cross-shard transaction.

---

## 7. Concurrency & Consistency

### 7.1 Single-key atomicity

A key maps to one shard; the shard applies charge/refund atomically. No locks,
no CAS retries in the common path.

### 7.2 Request id (no server-side idempotency)

Each `Charge`/`Refund` carries a `request_id`, but purely for
**logging/tracing/debugging** — it is threaded through logs and traces so a
charge can be correlated end-to-end. We deliberately do **not** dedup on it.

Server-side idempotency would mean storing one marker key per request (with a
few-seconds TTL) — roughly **doubling** the data-plane key count and memory. That
cost is not worth it here: charging is already best-effort under a fail-open,
approximate-accuracy model (§6.4, §9). The consequence is that a retried charge
re-applies (double-counts by its cost); the overshoot is bounded, self-corrects
at the next window reset, and only nudges a customer slightly earlier into
throttling — an acceptable trade for halving memory. Producers that truly need
exactly-once accounting can dedup on their own side before calling `Charge`.

### 7.3 Replication consistency

Primary/replica replication is asynchronous. A failover can lose the last few
writes (a few ms of charges). Consistent with fail-open philosophy: we may
under-count slightly across a failover, never block the product. We do **not**
use synchronous replication in the hot path — it would blow the latency budget.

---

## 8. Latency & Caching Strategy

Budget: **client-observed p99 ≤ 5 ms**, enforced by a hard deadline in the SDK.

Tiers, in order of increasing accuracy-for-latency trade:

1. **Direct-to-store (default).** One in-region gRPC hop → one shard op.
   Sub-millisecond store op; total dominated by network (~1–2 ms in-region).
   Accurate.
2. **Check-result caching.** For read-only `Check` on very hot keys, the SDK may
   cache an allow decision for a short TTL (e.g. 200 ms) — bounded staleness,
   big QPS reduction. Charges are never cached.
3. **Token lease / local bucket (opt-in, for hot keys at extreme scale).** The
   SDK leases a slice of quota (e.g. 100 tokens) from the central counter and
   serves checks/charges locally, syncing periodically. Cuts central QPS by the
   lease size; trades accuracy (a crashing instance loses its unused lease) for
   latency and cost. Reserved for the top few percent of keys by traffic.

Start with tier 1 everywhere; escalate hot keys to tiers 2–3 based on
observed QPS. This keeps the common case simple and accurate.

---

## 9. Failure Handling & Fail-Open

**Principle: the rate limiter failing must never fail the product.**

The fail-open logic lives in the **SDK**, so it works regardless of why the
service is unreachable.

| Failure | Behavior |
|---------|----------|
| RL service timeout (> deadline) | **Allow** the request. Emit metric. |
| RL service 5xx / unreachable | **Allow**. Circuit breaker opens; stop calling for a cooldown, allow all, periodically probe. |
| Counter shard down | Service returns a typed "degraded" signal; SDK **allows**. Only keys on that shard lose enforcement. |
| Config lookup fails | Serve last-known-good cached config; if none, **allow**. |
| Charge fails (post-processing) | Retry with backoff a bounded number of times, then drop and emit a metric. Retries are **not** deduped, so a late-succeeding retry may double-count (bounded, self-corrects at reset); we prefer that to blocking. |
| Malformed request | Typed `INVALID_ARGUMENT`; SDK treats as allow + logs (never throws into request path). |

**Fail-open is the only mode** — a rate limiter must never be the reason the
product is down, so on any RL failure the request is always allowed. The one knob
a producer tunes is the **deadline** (default 5 ms): how long to wait before
giving up and failing open.

---

## 10. Scalability & Sharding

- **Counter store:** consistent-hash shard on `counter_key`. A single key =
  single shard, preserving atomicity. Rebalancing moves key ranges; in-flight
  counters may reset on move — acceptable (bounded, rare).
- **Service tier:** stateless, autoscaled on CPU/QPS behind a regional load
  balancer.
- **Hot-key / hot-shard problem:** one customer can concentrate traffic on a
  single key → a single shard becomes a hotspot (can't be split, atomicity needs
  one owner). Mitigations: (a) token-lease/local aggregation (§8.3) to collapse
  many ops into few; (b) detect and replicate hot keys for read-only `Check`;
  (c) per-caller admission control so one abuser can't starve the shard.
- **Capacity math (sketch):** keys are tiny (~100 B incl. overhead). 100 M
  active `(customer, limit, window)` keys ≈ 10 GB — fits comfortably in a modest
  Redis cluster. TTLs keep only *active* windows resident.

---

## 11. Regional Model

- Each region runs an independent data plane (service + counter store) and
  enforces quota **using only that region's traffic**.
- The control plane (config) replicates globally.

**Consequence:** a limit of "1000/min" is enforced *per region*. A customer
hitting three regions could do up to 3000/min globally. Options, in order of
increasing cost:

1. **Per-region quotas (default).** Simple, no cross-region latency, fully
   available under partition. Document that limits are per-region, or divide the
   global cap across regions.
2. **Global cap via async reconciliation.** Regions periodically ship consumed
   counts to a global aggregator that adjusts per-region allowances. Eventually
   consistent; bursts can overshoot.
3. **Strict global cap.** Requires a single authoritative counter → cross-region
   round trips → violates latency/availability. **Rejected** for the general
   case; available only as an explicit, expensive opt-in.

We ship (1), with (2) as a roadmap item. This directly follows from the CAP
trade-off: under a network partition we choose availability (each region keeps
serving) over global consistency.

---

## 12. Thundering Herd & Synchronization

Fixed windows and shared infrastructure create several "everyone at once"
hazards. Two rules drive the mitigations below: **(a) never let a large set of
events happen at exactly the same instant** — jitter TTLs, cache expiries,
reconnect backoff, and (optionally) window phase; and **(b) never let N servers
independently stampede a recovering dependency** — bounded pools, backoff with
jitter, circuit breakers, single-flight, and stale-while-revalidate.

### 12.1 Synchronized TTL expiry

Because windows align to wall-clock boundaries (every minute key rolls at `:00`),
**every counter key for a given unit reaches `TTL=0` at the same instant.**
Millions of simultaneous expirations cause a Redis active-expiry CPU spike (the
expiry cycle churns one huge cohort at once) and a memory-reclamation cliff, both
of which show up as correlated latency on that shard.

Key insight: the quota **reset** is driven by `window_id` changing (the key
*name* changes at the boundary), **not** by TTL. TTL only reclaims the now-dead
previous-window key, which is never read again. That gives us total freedom to
delay and spread expiry.

**Mitigation — TTL jitter (baseline).** Set

```
TTL = window_remaining + grace + rand(0, J)
```

The jitter `J` (e.g. up to 10% of the window, capped — say ≤30 s for minute
windows, minutes for day/month) is **strictly additive** so it never shortens
TTL below `window_remaining` and can't expire a live key. Reclamation of the dead
cohort is smeared over `J` instead of spiking. Harmless because the dead key is
never read once `window_id` has advanced.

**Mitigation — per-key window phase offset (opt-in, stronger).** Derive a
deterministic offset from `hash(key)` and shift each key's window boundary by it,
so customer A resets at `:00` and customer B at `:17`. This spreads not just
expiry but the **boundary reset burst** (below) and new-key-creation load across
the shard. Cost: `reset_at` becomes per-key (still returned in every response, so
callers always see the correct value) and reasoning is slightly harder. Reserve
it for very hot keys/shards.

### 12.2 Boundary reset burst

At the window boundary, every throttled caller simultaneously finds quota
available again → a synchronized burst of allowed traffic **and** new-key writes
on the same shards. Mitigated by the phase offset (§12.1) and by service-tier
request coalescing (§12.4). This is the flip side of the fixed-window 2× burst
noted in §6.1.

### 12.3 Redis connection storms across many RL servers

The service tier is N stateless servers all talking to the same shards, so a
single dependency event fans out into N correlated reactions.

**Connection storm on failover/restart.** When a primary fails over or a shard
restarts, all N servers detect the drop and reconnect at the same moment → a
connection / `AUTH` / topology-discovery storm that can re-kill the just-recovered
node and start a retry loop. Mitigations:

- **Bounded, reused connection pools** per server — never connection-per-op.
- **Reconnect with exponential backoff + full jitter**:
  `sleep = rand(0, min(cap, base·2^attempt))`, so the N servers spread their
  reconnects instead of retrying in lockstep.
- **Per-shard circuit breaker.** On repeated failures, open the breaker, fail
  **open** on the data path (§9), and probe with a single trickle of connections;
  ramp back up **gradually** as health returns rather than reopening all N at once.
- **Health-gated ramp.** A recovering shard re-enters rotation behind a rising
  traffic cap (0→100 over seconds), not instantly.
- **Jittered topology refresh** so servers don't all rediscover cluster topology
  on the same tick.

### 12.4 Cache stampedes (dogpile)

Each server caches limit configs (and optionally hot check results) with a TTL.
If a hot entry expires everywhere at once, all N servers miss and hammer the
backing store simultaneously. Mitigations:

- **Jittered cache TTLs** so entries don't expire in lockstep.
- **Single-flight / request coalescing:** at most one in-flight fetch per key per
  server; concurrent callers await the same fetch.
- **Serve-stale-while-revalidate:** keep serving the old value while one
  background refresh runs; never block the hot path on a fetch. If refresh fails,
  §9 applies (serve last-known-good / allow).
- **Push invalidation** for config changes instead of pure TTL expiry, so caches
  refresh on *change* rather than on a synchronized clock.
- **Request coalescing on hot keys (service tier):** collapse concurrent
  identical read-only `Check`s on the same key within a few-ms window into one
  store read, fanning the result back out. `Charge`/`Refund` are **never**
  coalesced — each must apply.

---

## 13. Degradation Under Stress

The system degrades along documented, monotonic axes rather than falling over:

1. **Store CPU saturating** → service sheds load: escalate hot keys to
   token-lease mode, collapsing central QPS at the cost of accuracy.
2. **Higher** → shed read-only `Check` freshness (serve short-TTL cached
   decisions) before touching `Charge`, which stays authoritative.
3. **Higher still** → service returns "degraded"; SDKs fail open. Enforcement
   loosens gradually (per shard, per key), never a cliff.
4. **Service tier saturating** → autoscale; meanwhile deadlines trip and SDKs
   fail open.

At every step the *product* keeps serving; only *enforcement accuracy* degrades,
and it does so predictably (freshness → enforcement, in that order). This is the
"degrades predictably" requirement made concrete.

---

## 14. Cost

- **Dominant cost:** in-memory counter store. Bounded by TTLs (only active
  windows resident) and small keys. Exactly **one key per active
  `(customer, limit, window)`** — we deliberately keep no per-request dedup keys
  (§7.2), which would roughly double memory. Batching + token leases cut op count
  and therefore node count.
- **Compute:** stateless tier is cheap and scales to load; scales to near-zero
  in quiet regions.
- **Network:** all hot-path traffic is in-region (no cross-region egress).
- **Knobs:** raise cache/lease sizes to trade accuracy for fewer store ops.

---

## 15. Observability

- **Metrics:** check/charge/refund QPS, allow/deny rates, p50/p99/p999 latency,
  fail-open rate (a key SLO — high fail-open = we're not actually limiting),
  per-shard load, hot-key list, negative-quota incidence.
- **Herd/sync signals (§12):** key-expiry rate over time (should be smooth, not
  spiky), Redis reconnect rate + backoff attempts, connection-pool saturation,
  cache hit/miss + single-flight coalescing rate, config-fetch stampede count.
- **Per-customer/limit views** so producers can see who is being throttled.
- **Tracing:** propagate the caller's trace context through check/charge.
- **Alerts:** fail-open rate over threshold, shard hotspots, replication lag,
  config-propagation lag, correlated expiry/reconnect spikes.

---

## 16. Security & Multi-Tenancy

- **AuthN/Z:** producers authenticate (mTLS/service identity); a producer may
  only read/write its own `service_name`'s limits and counters.
- **Tenant isolation:** the hot-key/admission controls (§10) prevent one
  customer from degrading service for others — the fairness mandate applies to
  the limiter itself, not just its subjects.
- **Input validation:** caps on `cost`, key length, batch size.

---

## 17. Alternatives Considered

| Choice | Alternative | Why we chose as stated |
|--------|-------------|------------------------|
| Fixed window (only) | Sliding-window log / weighted sliding | Fixed is O(1) memory, predictable, cheap. Sliding rejected: not worth the memory/CPU for the ~2× boundary burst. |
| Fail-open (only) | Configurable fail-open/closed | One mode keeps the SDK and mental model simple; a limiter must never take the product down, so closed is never the right default. |
| Store `consumed` | Store `remaining` (tokens left) | `consumed` needs no init step and a missing key = full quota (safe default); resets are free via TTL and limit changes recompute instantly. `remaining` inverts the missing-key semantics to deny-all (dangerous), forces per-window seeding, and needs limit-change migration — while still needing the cap for refund-capping and seeding, so it saves no config lookups. Revisit only as part of reducing SQL-DB load (§18). |
| Non-reserving `Check` | Reserve-on-check | Matches the spec (charge after processing, may go negative); keeps pre-flight cheap. |
| Redis-compatible store | Custom counter service | Atomicity + TTL + Lua out of the box; operationally proven; avoids building a distributed counter from scratch. |
| Fail-open in SDK | Fail-open in service | SDK-side works even when the service is unreachable — the case that matters most. |
| Per-region enforcement | Strict global cap | Global cap needs cross-region coordination that breaks latency/availability. |

---

## 18. Resolved Decisions

The questions raised during design review are now resolved. Item numbers are
stable (referenced elsewhere, e.g. §6.5 and the component docs).

1. **Month-window refunds across a reset boundary — ACCEPTED as-is.** We do
   **not** implement exact monthly refunds. A refund that lands after its window
   reset over-credits the new window; this is bounded by the refund floor (§6.5)
   and is embarrassing but not a correctness blocker. No further work.
2. **Global caps — PER-REGION ONLY.** Enforcement stays per-region (§11); there
   is **no** cross-region reconciliation in this version. A customer spanning *N*
   regions can consume up to *N×* the cap globally — documented and accepted.
   Reconciliation (§11, option 2) remains a future option, not built now.
3. **Config propagation SLA — ≤ 5 seconds.** A limit change must take effect
   region-wide within **5 s**. This sets the change-feed poll interval plus
   `LISTEN/NOTIFY` push (§12.4); `quotamgmt` carries it as a propagation-lag SLO.
4. **Weighted / hierarchical limits — OUT OF SCOPE.** Not pursued in this
   version; deferred to a future design. The batch API mechanics exist, but
   cross-limit atomic all-or-nothing is explicitly not built now.
5. **Default deadline — SINGLE GLOBAL 5 ms.** One global 5 ms deadline applies to
   all producers (§9); no per-limit tuning in this version.
6. **Reducing SQL-DB (config) load — FUTURE WORK.** The in-process config cache
   (§6.2) is sufficient for launch. As tenant/limit count grows we'll push
   further — a shared read-through cache tier in front of Postgres, read replicas,
   bulk/preloaded config snapshots per service, or co-locating the resolved cap in
   the counter key (`{limit, consumed}`) to make Redis self-sufficient. Deferred,
   not built now.

---

## 19. Rollout Plan (sketch)

1. Control plane + config API; counter store; core `check/charge/refund` with
   fixed windows, single region.
2. Client SDK with deadlines, circuit breaker, fail-open, config cache.
3. Shadow mode: producers call the limiter but never enforce (measure allow/deny
   we *would* have made) to validate accuracy before enforcing.
4. Enable enforcement per limit with fail-open default.
5. Hot-key escalation (caching, token lease); observability polish.
6. Additional regions; evaluate global reconciliation (§11.2).

---

## Appendix A: Worked Example

Limit: `search-svc / cust_42 / default → 1000 / minute`.

```
t=00.000  Check(k)                 -> consumed=0,  remaining=1000, allowed
          ... process ...
          Charge(k, 3, req_a)      -> consumed=3,  remaining=997
t=00.100  Check(k)                 -> consumed=3,  remaining=997,  allowed
          Charge(k, 5, req_b)      -> consumed=8,  remaining=992
          (downstream failed)
          Refund(k, 5, req_b)      -> consumed=3,  remaining=997
...
          many concurrent requests near the cap:
          consumed=999; 4 requests pass Check simultaneously; each Charge(1)
          -> consumed=1003, remaining=-3   (bounded overshoot)
          next Check -> allowed=false -> 429
t=60.000  window rolls; key expires; consumed=0, remaining=1000
```

---

## Appendix B: Schemas

Two stores, two roles:

- **Postgres** — durable **source of truth for configuration** (control plane).
  Low QPS, strongly consistent, audited. Never in the hot path.
- **Redis** — **source of truth for live counters** (data plane). High QPS,
  in-memory, atomic. Holds the ephemeral consumed counters.

### B.1 Postgres (control plane)

```sql
-- ---------- enums ----------
-- Fixed-window is the only algorithm and fail-open the only failure mode,
-- so neither is a column.
CREATE TYPE time_unit AS ENUM ('MINUTE', 'DAY', 'MONTH');

-- ---------- registered producers (optional, for authz + FK) ----------
CREATE TABLE service (
    service_name  TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    owner         TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- the core config table ----------
-- Lean by design: identity + the limit itself. All who/when history lives in
-- limit_config_audit, so no created/updated columns here. One deployment per
-- region (no region column); limits are always enabled (no enabled column).
CREATE TABLE limit_config (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    service_name  TEXT        NOT NULL REFERENCES service(service_name),
    -- '*' = per-(service, rate_limit_id) DEFAULT; exact customer_id wins over it
    customer_id   TEXT        NOT NULL,
    rate_limit_id TEXT        NOT NULL,

    limit_value   BIGINT      NOT NULL CHECK (limit_value >= 0),  -- the cap
    time_unit     time_unit   NOT NULL,               -- MINUTE | DAY | MONTH (fixed window)

    CONSTRAINT uq_limit UNIQUE (service_name, customer_id, rate_limit_id)
);

CREATE INDEX idx_limit_service ON limit_config (service_name);

-- Resolution on a config-cache miss (§6.2): exact customer row, else '*' default;
-- no row => unconfigured => allow (§9).
--   SELECT limit_value, time_unit FROM limit_config
--    WHERE service_name=:svc AND rate_limit_id=:rlid AND customer_id IN (:cust,'*')
--    ORDER BY (customer_id = '*') LIMIT 1;

-- ---------- append-only audit / change history ----------
-- The full record of every change: before + after values, who, and when.
-- Also doubles as the change-feed the data plane polls to refresh its cache.
CREATE TABLE limit_config_audit (
    audit_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    config_id     BIGINT      NOT NULL,
    operation     TEXT        NOT NULL,      -- INSERT | UPDATE | DELETE
    old_row       JSONB,                     -- value before (NULL on INSERT)
    new_row       JSONB,                     -- value after  (NULL on DELETE)
    changed_by    TEXT        NOT NULL,      -- creator on INSERT, updater on UPDATE/DELETE
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_config     ON limit_config_audit (config_id, changed_at);
-- data-plane nodes poll "what changed since X?" off this index (§12.4)
CREATE INDEX idx_audit_changed_at ON limit_config_audit (changed_at);

-- Actor comes from a per-transaction session GUC, so it need not live on
-- limit_config:  SET LOCAL app.actor = 'alice';  before the write.
CREATE OR REPLACE FUNCTION limit_config_audit_write() RETURNS TRIGGER AS $$
DECLARE
    actor TEXT := current_setting('app.actor', true);
BEGIN
    IF actor IS NULL OR actor = '' THEN
        RAISE EXCEPTION 'app.actor must be set before writing limit_config';
    END IF;
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO limit_config_audit(config_id, operation, old_row, new_row, changed_by)
        VALUES (NEW.id, 'INSERT', NULL, to_jsonb(NEW), actor);
        RETURN NEW;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO limit_config_audit(config_id, operation, old_row, new_row, changed_by)
        VALUES (NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), actor);
        RETURN NEW;
    ELSE  -- DELETE
        INSERT INTO limit_config_audit(config_id, operation, old_row, new_row, changed_by)
        VALUES (OLD.id, 'DELETE', to_jsonb(OLD), NULL, actor);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_limit_config_audit
    AFTER INSERT OR UPDATE OR DELETE ON limit_config
    FOR EACH ROW EXECUTE FUNCTION limit_config_audit_write();
```

**Notes**
- **`limit_config` is intentionally lean** — just identity + the limit. There is
  no `region` (one deployment per region), no `enabled` (limits are always
  enabled — delete the row to remove a limit), and no `created/updated`
  timestamps or actor columns.
- **Default limits via `customer_id = '*'`.** A `'*'` row is the default for a
  `(service, rate_limit_id)`; a specific customer row overrides it. The data
  plane resolves exact-then-default on a config-cache miss (§6.2). The cap is
  **never** stored in Redis — Redis holds only `consumed`, and a missing counter
  key just means `consumed = 0` for a fresh window, not an unknown customer.
- **The audit table is the system of record for change history:** `old_row` /
  `new_row` capture the full before/after, `changed_by` the actor (creator on
  INSERT, updater on UPDATE/DELETE), `changed_at` the time. Actor is passed per
  transaction via `SET LOCAL app.actor = ...` and enforced by the trigger, so it
  never has to live on the config row.
- **Propagation:** data-plane servers keep a local config cache and refresh by
  polling the audit feed — `SELECT ... FROM limit_config_audit WHERE changed_at
  > :last_seen` (indexed) → reload the touched `config_id`s — and/or
  `LISTEN/NOTIFY` push (§12.4). Since updates are rare, a periodic full reload is
  also viable. Target: a change takes effect region-wide within **≤ 5 s**
  (§18, decision 3), so the poll interval is a few seconds with push to shorten
  the tail.
- **No optimistic-concurrency column.** Config writes are rare (per service /
  customer / limit) and Postgres gives strong consistency, so a plain
  transactional `UPDATE` is sufficient — no `version`/CAS needed.
- **Not in Postgres:** live counters. They churn far too fast (every charge) to
  belong in an ACID row and would make Postgres the hot-path bottleneck.

### B.2 Redis (data plane)

**Key layout.** One key per active `(customer, limit, window)`. A hash tag
`{svc|cust|rlid}` keeps a limit's successive-window keys on the **same cluster
slot** (tidy for locality/inspection; each op still touches a single key).

```
counter :  rl:{<svc>|<cust>|<rlid>}:cnt:<window_id>   -> String(int64)  consumed
```

There is **no idempotency/dedup key** — that would add one key per request and
roughly double memory (§7.2); `request_id` is used only for logging/tracing.

| Aspect | Choice | Why |
|--------|--------|-----|
| Type | plain String + `INCRBY`/`DECRBY` | per-key atomic counter; TTL is per-key (needed for reset) — a Hash can't expire individual fields. |
| `window_id` | UTC-aligned bucket id (`YYYYMMDDHHmm` / `YYYYMMDD` / `YYYYMM`), or phase-shifted per §12.1 | key name *is* the reset — old window key is abandoned, not mutated. |
| TTL | `window_remaining + grace + jitter`, set once at key creation | implicit reset + smeared expiry (§12.1). Server computes the jitter and passes it in, keeping scripts deterministic. |
| Idempotency | **none** — retries re-apply | avoids ~2× memory; charging is best-effort under fail-open (§7.2). |
| Durability | replicas + RDB snapshots; AOF optional | counters are ephemeral and we fail-open — a lost shard just resets quota, it never blocks the product. Strong durability not worth the cost. |

**Atomic operations (Lua, run on the key's owning shard).** The server passes the
already-jittered TTL and the resolved limit as arguments so the scripts stay
deterministic (safe for replication). Each script touches a single key.

```lua
-- CHARGE  KEYS[1]=cnt  ARGV[1]=cost  ARGV[2]=limit  ARGV[3]=ttl_s
local consumed = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if redis.call('TTL', KEYS[1]) < 0 then                 -- brand-new window key
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))   -- set jittered TTL once
end
return tonumber(ARGV[2]) - consumed                    -- remaining; may be negative (by design)
```

```lua
-- REFUND  KEYS[1]=cnt  ARGV[1]=amount  ARGV[2]=limit
local consumed = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if consumed < 0 then
    redis.call('INCRBY', KEYS[1], -consumed)           -- floor at 0, PRESERVES TTL
    consumed = 0                                       -- (avoids SET, which drops TTL)
end
return tonumber(ARGV[2]) - consumed                    -- remaining
```

```lua
-- CHECK (read-only)  KEYS[1]=cnt  ARGV[1]=limit  ARGV[2]=cost
local consumed  = tonumber(redis.call('GET', KEYS[1]) or '0')
local remaining = tonumber(ARGV[1]) - consumed
return { (remaining >= tonumber(ARGV[2])) and 1 or 0, remaining }
```

The negative-`remaining` path in `Charge` is intentional (§6.4); `Refund`'s floor
uses `INCRBY` rather than `SET` specifically to **preserve the window TTL** (a
`SET` would clear it and break the reset).
