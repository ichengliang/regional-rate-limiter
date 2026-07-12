# Detailed Design: `quotaenforcer` (Data Plane)

**Status:** Draft
**Author:** chengliangzhang@gmail.com
**Date:** 2026-07-12
**Parent:** [`regional-rate-limiter-design.md`](../regional-rate-limiter-design.md) (high-level)
**Siblings:** `quotamgmt` (control plane), `quotaui` (admin UI)

---

## 1. Overview & Scope

`quotaenforcer` is the **data plane** of the Regional Rate Limiting Service — the
hot path that answers `CheckQuota`, `Charge`, and `Refund` at request time. It is
the component named "Rate Limiter Client SDK + Rate Limiter Service + Counter
store" in the high-level architecture (parent §5). This document is the
next-level design of that component: the SDK internals, the stateless service
tier, the Redis counter store, and the request flows that bind them.

Everything here inherits the locked decisions of the parent doc and does not
re-litigate them. In particular: **fixed-window counters**, **fail-open only**,
Redis stores **consumed** (not remaining), the cap comes from `quotamgmt` config
(never from Redis), **no server-side idempotency**, and enforcement is
**per-region**. Where this doc says "the parent" it means
`regional-rate-limiter-design.md`; section numbers like "§12" refer to the parent
unless prefixed with this file's own section.

### 1.1 Scope

In scope:

- The **Client SDK** embedded in each producer: deadline, circuit breaker,
  fail-open, batching, optional token lease, and the config-cache placement.
- The **stateless RL Service tier** (`quotaenforcer` service): validation, config
  resolution, `window_id` computation, shard routing, Lua dispatch.
- The **Redis counter store**: key schema, the three Lua scripts, sharding,
  replication/durability, TTL & jitter, and `window_id` math.
- Hot-path failure handling, thundering-herd mitigations for the data plane,
  degradation ladder, deployment topology, observability, and rollout.

### 1.2 Non-goals

- **Config CRUD, audit, defaults authoring, RBAC** — owned by `quotamgmt` and
  surfaced by `quotaui`. `quotaenforcer` is a *read-only consumer* of config.
- **Strict global caps / cross-region reconciliation** — parent §11; per-region
  only here.
- **Server-side dedup / exactly-once accounting** — parent §7.2; explicitly out.
- **Sliding windows, billing, authorization** — parent §1.2, §6.1.
- **The admin UI's live-usage read API** — that read path is served by the RL
  Service's read endpoint (parent §5.1), but the UI itself is `quotaui`.

### 1.3 Latency budget

The governing SLO is **client-observed p99 ≤ 5 ms** for a single `CheckQuota` or
`Charge` (parent §8, N1). "Client-observed" means measured in the producer around
the SDK call, so it includes serialization, the in-region network hop, the store
op, and the return — not just Redis time. The budget decomposes roughly as:

| Segment | Typical | Notes |
|---------|---------|-------|
| SDK overhead (validate, route, serialize) | < 0.2 ms | in-process, no allocation on the hot path |
| Config resolution | ~0 ms (cache hit) | read-through cache; miss is rare (§5) |
| Network RTT (producer ↔ service, in-region) | ~0.5–1.5 ms | same AZ preferred |
| Service → Redis RTT + Lua exec | ~0.3–0.8 ms | single-key op, single-threaded shard |
| **Deadline (hard cutoff, SDK-owned)** | **5 ms default** | on breach: fail open (allow) |

The **deadline is the backstop, not the target.** The design aims for p99 well
under it so that hitting the deadline is a real signal (a slow shard, a GC pause,
a network blip) rather than normal operation. When the deadline trips, the SDK
**allows** the request and records a fail-open (parent §9); fail-open rate is a
top-line SLO (§12).

---

## 2. Components & Responsibilities

Three cooperating pieces, in decreasing proximity to the producer:

```
┌──────────────────────── Producer process ─────────────────────────┐
│  application code                                                   │
│      │ check / charge / refund                                      │
│      ▼                                                              │
│  ┌───────────────────────── Client SDK ─────────────────────────┐  │
│  │  • deadline (≤5 ms) + per-shard circuit breaker              │  │
│  │  • fail-open decision (the ONLY place it is made)            │  │
│  │  • config cache (read-through from quotamgmt)                │  │
│  │  • window_id computation                                     │  │
│  │  • batching / coalescing                                     │  │
│  │  • (opt-in) token lease / local bucket for hot keys          │  │
│  │  • bounded gRPC connection pool + backoff-with-jitter        │  │
│  └───────────────────────────┬─────────────────────────────────┘  │
└──────────────────────────────┼────────────────────────────────────┘
                               │ gRPC (in-region, mTLS)
                               ▼
        ┌──────────────────── RL Service tier (stateless) ───────────────────┐
        │  • request validation (cost caps, key length, batch size)          │
        │  • config resolution (shared config cache, read-through quotamgmt)  │
        │  • window_id + jittered TTL computation                            │
        │  • shard routing (cluster slot from hash tag)                       │
        │  • EVALSHA dispatch of charge/refund/check                          │
        │  • read API for quotaui live-usage (read-only)                      │
        └───────────────────────────┬───────────────────────────────────────┘
                                    │ RESP / EVALSHA
        ┌───────────────────────────┼───────────────────────────────────────┐
        ▼                           ▼                                        ▼
  ┌───────────┐              ┌───────────┐                            ┌───────────┐
  │ shard 0   │              │ shard 1   │   ... (Redis Cluster) ...  │ shard N   │
  │ primary   │              │ primary   │                            │ primary   │
  │  +replica │              │  +replica │                            │  +replica │
  └───────────┘              └───────────┘                            └───────────┘
```

### 2.1 Client SDK (in the producer)

The SDK is where **latency and availability guarantees are actually enforced**
(parent §5, §9). Responsibilities:

- **Own the deadline.** Every call carries a gRPC deadline (default 5 ms). The SDK
  never blocks the request path beyond it.
- **Own the fail-open decision.** On timeout, transport error, `UNAVAILABLE`,
  degraded signal, or a tripped breaker, the SDK returns `allowed = true`. This is
  the single chokepoint for fail-open so it behaves identically no matter *why*
  the service is unreachable.
- **Circuit breaker, per target shard/endpoint.** Repeated failures open the
  breaker; while open the SDK fails open locally without a network call and
  probes periodically (§6.2).
- **Config cache (optional co-location).** For latency-critical producers the SDK
  can hold the read-through config cache so even config resolution is in-process
  (§5.4). The default deployment keeps the cache in the service tier; both are
  supported.
- **Batching & coalescing.** Combine multiple keys (per-customer *and* per-org)
  into one `CheckQuotaBatch` / `ChargeBatch` round trip (§6.4).
- **Optional token lease / local bucket** for hot keys (§6.5, §9.3).

The SDK is thin, allocation-light, and **never throws into the request path**
(parent N5): all errors resolve to allow-and-emit-metric.

### 2.2 RL Service tier (stateless)

A horizontally scaled, autoscaled fleet behind a regional L4/L7 load balancer.
Stateless so instances are fungible and can be killed freely. Per request it:

1. Validates the request (typed `INVALID_ARGUMENT` on failure — cost/key/batch
   caps, parent §16).
2. Resolves the **cap** from the config cache (read-through to `quotamgmt`; §5).
3. Computes `window_id` and the **jittered TTL** (§4.5, §4.6).
4. Routes to the owning shard via the key's hash tag → cluster slot (§4.3).
5. Dispatches the correct Lua script by `EVALSHA` (§4.2).
6. Maps the store result to the typed response `{allowed?, remaining, limit,
   reset_at}` and returns it.

The service also exposes a **read-only live-usage endpoint** consumed by `quotaui`
(parent §5.1) — the same `CHECK` script plus a `GET consumed` for display. It
never lets `quotaui` touch Redis directly.

> **Why a service tier at all, vs. SDK-direct-to-Redis?** Centralizing shard
> topology, EVALSHA script management, config-cache warmth, and connection
> pooling in a fleet of ~dozens of instances is dramatically cheaper and safer
> than fanning thousands of producer processes directly onto Redis (connection
> explosion, topology churn, script cache misses). The extra hop costs ~1 ms and
> buys a bounded, observable, poolable client population — decisive for the
> connection-storm mitigations in parent §12.3.

### 2.3 Redis counter store

A sharded, replicated, in-memory store with atomic ops and per-key TTL — the
**source of truth for live counters** (parent Appendix B). Redis (or a
Redis-compatible engine) is the baseline: single-threaded per shard gives
atomicity for free, `INCRBY`/`DECRBY` + Lua cover charge/refund/check, native TTL
drives implicit reset. Holds exactly **one key per active `(customer, limit,
window)`** — no dedup keys (parent §7.2). Ephemeral by design: a lost shard just
resets quota, it never blocks the product.

---

## 3. Request Flows

All three operations share the same spine: **resolve cap → compute `window_id` →
run the store op under a deadline → map to response, failing open on any error.**
The deadline and the fail-open decision live in the SDK; the cap and `window_id`
are computed before the store op so the Lua scripts stay deterministic (parent
Appendix B.2).

### 3.1 Check (read-only, advisory, non-reserving)

```
producer          SDK                         RL Service                 Redis shard
   │  check(key,cost) │                              │                        │
   │─────────────────▶│                              │                        │
   │                  │ breaker open? ──yes──▶ ALLOW (fail-open), emit metric  │
   │                  │ no                           │                        │
   │                  │ config cached? ─yes─┐        │                        │
   │                  │  (cap in hand)      │        │                        │
   │                  │  set deadline=5ms   │        │                        │
   │                  │─────── CheckQuota(key,cost,cap?) ──▶│                  │
   │                  │                              │ resolve cap (cache)     │
   │                  │                              │ window_id = f(now,unit) │
   │                  │                              │ route → slot            │
   │                  │                              │── EVALSHA CHECK ───────▶│
   │                  │                              │   GET consumed (→0 miss)│
   │                  │                              │◀── {allowed, remaining}─│
   │                  │◀───── {allowed,remaining,limit,reset_at} ──│          │
   │◀── allowed ──────│                              │                        │
```

Steps:

1. **SDK breaker gate.** If the per-shard breaker is open, return `allowed=true`
   immediately (fail open), emit `fail_open`. No network call.
2. **Deadline armed** at 5 ms (default).
3. **Cap resolution.** If the SDK holds the config cache and has the entry, it
   passes the cap; otherwise the service resolves it from its own cache
   (read-through to `quotamgmt`, §5). On config miss → **allow** (unconfigured =
   unlimited, parent §6.2/§9).
4. **`window_id`** computed from `now` + unit (§4.6).
5. **`EVALSHA CHECK`** on the owning shard: `consumed = GET key or 0`,
   `remaining = cap - consumed`, `allowed = remaining >= cost`. Read-only, no
   mutation, no TTL touched.
6. Response `{allowed, remaining, limit, reset_at}`. A deny surfaces to the end
   consumer as HTTP `429` (parent F2). **Any** error/timeout on the way →
   `allowed=true`.

`Check` is advisory and does **not** reserve (parent §3.2). It is safe to cache
for a few hundred ms on hot keys (§8.2) and safe to coalesce (§8.3).

### 3.2 Charge (applied after processing; always succeeds; may go negative)

```
producer          SDK                         RL Service                 Redis shard
   │ ...request processed...                          │                        │
   │ charge(key,cost,req_id)                          │                        │
   │─────────────────▶│ breaker open? ─yes─▶ drop+enqueue-retry, emit metric   │
   │                  │ no; deadline=5ms             │                        │
   │                  │──── Charge(key,cost,req_id,cap?) ──▶│                  │
   │                  │                              │ resolve cap             │
   │                  │                              │ window_id, jittered TTL │
   │                  │                              │── EVALSHA CHARGE ──────▶│
   │                  │                              │  INCRBY key cost        │
   │                  │                              │  if TTL<0: EXPIRE ttl   │
   │                  │                              │◀── remaining (may be <0)│
   │                  │◀──── {remaining,limit,reset_at} ───│                  │
   │◀── remaining ────│                              │                        │
```

Steps:

1. Charge is called **after** the request is processed (parent §3.2); the actual
   `cost` is now known. It may be fire-and-forget from the producer's view.
2. SDK breaker gate; if open, the charge is enqueued for bounded retry (§6.3) and
   a metric emitted — the request itself is already served, so this never blocks
   the product.
3. Service resolves the cap, computes `window_id` **and the jittered TTL**
   (`window_remaining + grace + rand(0,J)`, §4.5), and dispatches `CHARGE`.
4. `CHARGE` (Lua, atomic on the owning shard): `INCRBY key cost`; if the key is
   brand-new (`TTL < 0`) set the jittered `EXPIRE` **once**; return
   `cap - consumed`. **Charge always applies** and may drive `remaining` negative
   — this is by design (parent §6.4). Subsequent checks correctly deny until
   reset.
5. On timeout/error the SDK does **not** fail the product; it records the charge
   as failed and may retry (bounded, un-deduped — a late retry can double-count,
   bounded and self-correcting at reset; parent §7.2, §9).

### 3.3 Refund (floored so consumed never < 0)

```
producer          SDK                         RL Service                 Redis shard
   │ refund(key,amount,req_id)                        │                        │
   │─────────────────▶│ deadline=5ms                 │                        │
   │                  │──── Refund(key,amount,req_id,cap?) ─▶│                 │
   │                  │                              │ resolve cap, window_id  │
   │                  │                              │── EVALSHA REFUND ──────▶│
   │                  │                              │  DECRBY key amount      │
   │                  │                              │  if <0: INCRBY -consumed│
   │                  │                              │         (floor, keep TTL)│
   │                  │                              │◀── remaining ───────────│
   │                  │◀──── {remaining,limit,reset_at} ───│                  │
```

Steps:

1. Refund credits quota back after a downstream failure (parent §3.2). It carries
   `request_id` for tracing only.
2. `REFUND` (Lua, atomic): `DECRBY key amount`; if the result is negative,
   `INCRBY -consumed` to floor at 0 **using INCRBY, not SET, to preserve the
   window TTL** (a `SET` would drop the TTL and break implicit reset — parent
   Appendix B.2). Return `cap - consumed`.
3. Refund does **not** create a TTL if the key is absent — a refund with no prior
   charge just yields `consumed = 0` (floored) and the key, if created by DECRBY,
   is left with the DECRBY result floored to 0; see §7.3 for the edge case and
   why it is benign.
4. **Edge case (carried from parent §6.5):** a refund arriving after its window
   has reset credits the *new* window. Floored and bounded; for the month window
   this over-credit is accepted as-is, not fixed (parent §18 decision 1).

### 3.4 Where the deadline and fail-open sit — summary

| Concern | Location | Rationale |
|---------|----------|-----------|
| Deadline (5 ms) | **SDK**, per call | Works even if the service never responds. |
| Fail-open decision | **SDK** | Single chokepoint; independent of failure cause (parent §9). |
| Cap resolution + fallback-to-allow | Service cache (or SDK cache) | Read-through; miss → allow (parent §6.2). |
| `window_id` + jittered TTL | **Service** (or SDK if it computes) | Keeps Lua deterministic (parent Appendix B.2). |
| Atomicity | **Redis shard** (Lua) | Single-key, single-threaded (§7). |

### 3.5 Worked examples

Data-plane RPCs are `quotaenforcer.v1.RateLimiter/{CheckQuota,Charge,Refund}`
(gRPC, with an HTTP/JSON gateway for non-gRPC callers). `key` is the tuple
`{service_name, customer_id, rate_limit_id}`. Producers normally go through the
**SDK** (§6), which arms the 5 ms deadline and owns the fail-open path; the wire
calls below show what actually crosses to the RL Service. Field names are the
proto's `snake_case`; int64 fields shown as numbers for readability.

Assume `search-svc / cust_42 / requests_per_min` resolves to a **1000/min** cap
(created in the `quotamgmt` examples, §3.11 there).

**1 — Check, quota available** (grpcurl)

```
grpcurl -d '{
  "key": { "service_name": "search-svc", "customer_id": "cust_42", "rate_limit_id": "requests_per_min" },
  "cost": 1
}' quotaenforcer.us-east.internal:443 quotaenforcer.v1.RateLimiter/CheckQuota
→ { "allowed": true, "remaining": 1000, "limit": 1000, "reset_at": "2026-07-12T14:31:00Z" }
```

Brand-new window: the Redis counter key is absent, so `consumed = 0` and
`remaining = 1000` — full quota. A missing key is the *safe* state, not "unknown
customer" (parent §6.2).

**2 — Charge after processing** (cost 3)

```
POST /v1/charge
{ "key": { "...": "cust_42" }, "cost": 3, "request_id": "req_a1b2c3" }
→ { "remaining": 997, "limit": 1000, "reset_at": "2026-07-12T14:31:00Z" }
```

`request_id` is carried for tracing only — there is **no dedup** (parent §7.2). A
network retry of this exact call charges again (→ `remaining: 994`); bounded and
self-correcting at the next reset.

**3 — Refund after a downstream failure** (credit the 3 back)

```
POST /v1/refund
{ "key": { "...": "cust_42" }, "amount": 3, "request_id": "req_a1b2c3" }
→ { "remaining": 1000, "limit": 1000, "reset_at": "2026-07-12T14:31:00Z" }
```

**4 — Check, quota exhausted → deny → 429.** Near the cap, `remaining` can be
negative (concurrent charges overshoot, parent §6.4):

```
POST /v1/check   { "key": { "...": "cust_42" }, "cost": 1 }
→ { "allowed": false, "remaining": -2, "limit": 1000, "reset_at": "2026-07-12T14:31:00Z" }
```

The producer maps `allowed=false` to **HTTP 429** for its consumer (parent F2),
and may set `Retry-After` from `reset_at`.

**5 — Batch check** — a per-minute customer limit and a per-day org limit in one
round trip (§6.4). **Each result mirrors the full single-`CheckQuota` response,
including its own `reset_at`** — batched keys can have different windows, so their
reset times differ.

```
POST /v1/check:batch
{ "requests": [
    { "key": { "service_name": "search-svc", "customer_id": "cust_42", "rate_limit_id": "requests_per_min" },  "cost": 1 },
    { "key": { "service_name": "search-svc", "customer_id": "org_9",   "rate_limit_id": "org_tokens_per_day" }, "cost": 500 }
] }
→ { "results": [
      { "allowed": true, "remaining": 996,   "limit": 1000,  "reset_at": "2026-07-12T14:31:00Z" },   // MINUTE window
      { "allowed": true, "remaining": 41200, "limit": 50000, "reset_at": "2026-07-13T00:00:00Z" }    // DAY window
] }
```

The producer denies (429) if **any** result is `allowed=false`, and sets
`Retry-After` from the `reset_at` of the limit(s) that denied — which is why the
reset time must be per-result, not shared. (The same applies to `Charge`/`Refund`
batch results: each carries its own `remaining`, `limit`, and `reset_at`.)

**6 — Fail-open (no server response).** If the shard/service is unreachable and
the 5 ms deadline trips, the **SDK** synthesizes an allow locally:

```
sdk.check(...) → { allowed: true, remaining: null, limit: null, fail_open: true }
```

No 429 is ever produced from an RL failure (parent §9). `fail_open` is an
SDK-local flag/metric, not a field the server returns.

**7 — End-to-end (the common path),** values threaded through one request:

| Step | Call | Result |
|------|------|--------|
| gate | `CheckQuota(cust_42, cost=1)` | `allowed=true, remaining=1000` |
| serve | *process the request* | — |
| bill | `Charge(cust_42, cost=1, request_id="r1")` | `remaining=999` |
| (on downstream 5xx) | `Refund(cust_42, amount=1, request_id="r1")` | `remaining=1000` |
| next window @14:31:00 | key expires; `CheckQuota(cust_42)` | `remaining=1000` (reset) |

---

## 4. Redis Design

### 4.1 Key schema

One key per active `(customer, limit, window)` (parent Appendix B.2):

```
counter :  rl:{<svc>|<cust>|<rlid>}:cnt:<window_id>   -> String(int64)  consumed
```

- **`rl:` prefix** namespaces all enforcer keys.
- **`{<svc>|<cust>|<rlid>}`** is a Redis Cluster **hash tag** (the `{...}`): only
  the bytes inside the braces are hashed to a slot. So every successive-window key
  for one limit lands on the **same slot** — locality for inspection and
  admin-UI reads, while each op still touches exactly one key (§4.3).
- **`cnt:<window_id>`** distinguishes the counter from any future per-limit
  metadata and encodes the window.
- **Value** is a plain `String` holding an int64 `consumed`. Not a Hash: TTL is
  per-key and a Hash cannot expire individual fields, but reset is per-window
  (parent Appendix B.2).
- **No dedup/idempotency key** — that would add one key per request and ~2× the
  memory (parent §7.2).

### 4.2 The three Lua scripts

`schema/redis_scripts.lua` is the **source of truth**; reproduced here for the
data-plane narrative. All three run server-side via `EVALSHA` on the key's owning
shard. The server passes `window_id`, the **already-jittered TTL**, and the
**resolved cap** as arguments so the scripts are deterministic and
replication-safe (parent Appendix B.2). Each touches a single key.

```lua
-- CHARGE   KEYS[1]=counter  ARGV[1]=cost  ARGV[2]=limit  ARGV[3]=ttl_seconds
--   always applies; remaining may go negative by design
local consumed = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if redis.call('TTL', KEYS[1]) < 0 then              -- brand-new window key
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))  -- set jittered TTL ONCE
end
return tonumber(ARGV[2]) - consumed                 -- remaining (may be < 0)
```

```lua
-- REFUND   KEYS[1]=counter  ARGV[1]=amount  ARGV[2]=limit
--   floored at 0; INCRBY not SET so the window TTL is PRESERVED
local consumed = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if consumed < 0 then
    redis.call('INCRBY', KEYS[1], -consumed)        -- back to 0, TTL kept
    consumed = 0
end
return tonumber(ARGV[2]) - consumed                 -- remaining
```

```lua
-- CHECK (read-only)  KEYS[1]=counter  ARGV[1]=limit  ARGV[2]=cost
local consumed  = tonumber(redis.call('GET', KEYS[1]) or '0')  -- miss => 0
local remaining = tonumber(ARGV[1]) - consumed
return { (remaining >= tonumber(ARGV[2])) and 1 or 0, remaining }
```

Notes tying back to locked decisions:

- **`CHARGE` sets TTL only when `TTL < 0`** (`-1` = key exists w/o TTL, `-2` = key
  absent → after `INCRBY` it exists w/o TTL, so still `< 0` on first touch). This
  makes the TTL "set once at key creation" (parent). It is **not** re-extended on
  later charges, so the window truly expires at boundary + jitter and reset is
  implicit.
- **`REFUND` floors with `INCRBY -consumed`, never `SET`** — the whole point is to
  keep the TTL (parent Appendix B.2). A `SET 0` would strip the TTL and the dead
  window would never expire (memory leak) *and* a live window would lose its
  reset.
- **`CHECK` treats a missing key as `consumed = 0`** = full quota for a fresh
  window (a safe default, **not** a signal about an unknown customer — parent
  §4.2, §6.2). The cap always comes from config.

Script management: scripts are loaded with `SCRIPT LOAD` at service startup and
per-shard on reconnect; the SDK/service call `EVALSHA` and fall back to `EVAL`
once on `NOSCRIPT` (e.g. after a shard restart flushed its script cache), then
re-`LOAD`. Topology refresh (parent §12.3) re-primes the cache with jitter so N
servers don't all `SCRIPT LOAD` in lockstep.

### 4.3 Sharding: Redis Cluster & hash tags

- **Redis Cluster** with hash-slot sharding (16384 slots) is the baseline; a
  consistent-hash proxy layer is an equivalent alternative if a non-cluster engine
  is used (parent §10). Either way: **a key lives on exactly one shard**, which is
  what makes the single-key Lua ops atomic without distributed locks (parent §6.6,
  §7.1).
- **Hash tag `{svc|cust|rlid}`** pins all windows of one limit to one slot. This
  is deliberately *not* tagging on `window_id`: we want successive windows of the
  same limit co-located (locality, easy `SCAN` for admin/debug, and cheap
  multi-window reads) while spreading *different* limits across the whole slot
  space. Because each op is single-key, co-location never creates a cross-slot
  transaction.
- **Rebalancing / resharding** moves slot ranges between shards. In-flight
  counters on a migrating slot may reset on move (the key is re-created empty on
  the new owner if migration races an expiry). This is **bounded and rare** and,
  per fail-open philosophy, an acceptable transient under-count (parent §10, §7.3).
- **Hot-shard risk:** one customer's single key concentrates load on one shard and
  a single key **cannot** be split (atomicity needs one owner). Mitigations in §9.

### 4.4 Replication & durability stance

Counters are **ephemeral** and the system is **fail-open**, so durability is
deliberately weak in exchange for latency and cost (parent Appendix B.2, §7.3):

| Mechanism | Setting | Why |
|-----------|---------|-----|
| **Primary + replica** per shard | 1 replica min, multi-AZ | HA / fast failover; not for durability guarantees. |
| **Replication mode** | **asynchronous** | Synchronous replication would blow the 5 ms budget (parent §7.3). A failover may lose the last few ms of charges → slight under-count, never a block. |
| **RDB snapshots** | periodic (e.g. every few min) | Cheap warm restart; losing a few minutes of counters just resets some quota early — harmless under fail-open. |
| **AOF** | **optional / off by default** | Per-write fsync cost isn't worth it for ephemeral counters; enable only if a specific tenant needs tighter continuity. |

The guiding rule: **a lost shard resets quota; it never fails the product.**
Losing counters is a fairness blip, not an outage.

### 4.5 TTL & jitter

TTL is set **once at key creation** by `CHARGE` (§4.2):

```
TTL = window_remaining + grace + rand(0, J)          // server-computed, passed in
```

- **`window_remaining`** = seconds from now to the window's end (§4.6). Ensures a
  live key never expires before its window closes.
- **`grace`** = a small pad (e.g. a few seconds) so late-arriving charges/refunds
  for the just-closed window still land on the right key before it is reclaimed.
- **`rand(0, J)`** = strictly-additive jitter (parent §12.1) so the huge cohort of
  same-unit keys does not all reach `TTL=0` at the same instant. `J` is capped
  (e.g. ≤ 30 s for minute windows, minutes for day/month). Additive means it can
  never shorten TTL below `window_remaining` — a live key is never at risk.

Because **reset is driven by `window_id` changing, not by TTL** (parent §12.1),
the dead previous-window key is never read again; smearing its reclamation over
`J` is free correctness-wise and spares the shard an active-expiry CPU spike +
memory cliff. The server computes the jittered value and passes it in, keeping the
Lua deterministic (parent Appendix B.2).

### 4.6 `window_id` math

`window_id` is derived from the wall clock aligned to the unit boundary in **UTC**
(parent §6.1), so every node computes the same key from the same clock with no
coordination:

| Unit | `window_id` format | Alignment | `window_remaining` |
|------|--------------------|-----------|---------------------|
| `MINUTE` | `YYYYMMDDHHmm` | start of minute | to next `:00` (~≤ 60 s) |
| `DAY` | `YYYYMMDD` | 00:00:00 UTC | to next midnight UTC |
| `MONTH` | `YYYYMM` | 1st 00:00 UTC | to 1st of next month UTC |

- **MONTH is calendar-aware**, not a fixed second count: `window_remaining`
  computes the actual instant of the 1st of the next month (28/29/30/31-day
  months, leap years) via a calendar library, **never** `30*86400` (parent §6.1).
- **Clock skew** between nodes only matters within a boundary window and is bounded
  by NTP (< 100 ms) — negligible for minute+ windows (parent §6.1).

**Optional per-key phase offset** (parent §12.1, stronger, opt-in for hot
keys/shards):

```
phase   = hash(svc|cust|rlid) mod window_seconds      // deterministic per key
window_id = align(now - phase, unit)                  // shifted boundary
window_remaining = (boundary(now - phase) + window_seconds) - now
reset_at        = boundary + phase                    // returned per-key in every response
```

The offset shifts each key's boundary deterministically (customer A resets at
`:00`, B at `:17`), spreading the **reset burst** and new-key-creation load across
the shard, not just TTL expiry. Cost: `reset_at` becomes per-key — always returned
in the response so callers still see the correct value — and reasoning is slightly
harder. Reserve for very hot keys (§9.2).

---

## 5. Config Cache (read-through from `quotamgmt`)

The cap is **never** in Redis; it comes from `quotamgmt`'s Postgres config,
resolved through an in-process **config cache** (parent §6.2). This section
details that cache as it lives in the data plane.

### 5.1 Read-through resolution

On a cache miss the resolver runs the exact-then-default query against `quotamgmt`
(via its read API / a read replica; parent §6.2, `schema/postgres.sql`):

```sql
SELECT limit_value, time_unit FROM limit_config
 WHERE service_name = :svc AND rate_limit_id = :rlid
   AND customer_id IN (:cust, '*')     -- exact OR the '*' default
 ORDER BY (customer_id = '*')          -- FALSE(exact) sorts before TRUE(default)
 LIMIT 1;
```

- **Exact customer row wins** over the `'*'` default (parent §6.2, F1).
- The resolved `{limit_value, time_unit}` is cached under
  `(svc, cust, rlid)` with a **jittered TTL** (§12.4 dogpile avoidance).

### 5.2 Default (`'*'`) resolution

A `customer_id = '*'` row is the per-`(service, rate_limit_id)` **default** applied
to any customer without an explicit override (parent F1, §6.2). The cache stores
the *resolved* cap per concrete `(svc, cust, rlid)`, so a customer riding the
default still gets an O(1) cache hit after the first miss; the default row itself
is also cached so a burst of new customers all resolving to `'*'` shares one entry
after single-flight (§5.5).

### 5.3 Negative caching (unconfigured → allow)

If **no row** matches (neither exact nor `'*'`), the limit is *unconfigured*.
Consistent with fail-open, we **allow** (treat as unlimited) and **cache the
negative result briefly** so a cold/unknown customer cannot stampede `quotamgmt`
(parent §6.2, §12.4). Negative entries get a short jittered TTL; a later config
create is picked up by the change-feed refresh (§5.4) or the TTL expiry, whichever
is first.

### 5.4 Refresh via the audit change-feed

Rather than relying on TTL alone, the data plane refreshes on **change** by
polling `quotamgmt`'s audit feed (parent §12.4, `limit_config_audit`):

```sql
SELECT config_id, new_row FROM limit_config_audit
 WHERE changed_at > :last_seen          -- indexed: idx_audit_changed_at
 ORDER BY changed_at;
```

Touched `config_id`s are reloaded (or evicted) in the local cache; `:last_seen`
advances. `LISTEN/NOTIFY` push is an alternative/complement for lower propagation
lag. Because config writes are rare relative to data-plane QPS, even a periodic
full reload is viable (parent Appendix B.1 notes). Propagation SLA is **≤ 5 s**
region-wide (parent §18 decision 3), which sets the poll interval + push.

### 5.5 Failing open when config is unavailable

| Situation | Behavior |
|-----------|----------|
| Cache **hit** | Use cached cap (the overwhelming common case). |
| Cache **miss**, `quotamgmt` reachable | Read-through, cache result (incl. negative). |
| Cache **miss**, `quotamgmt` **unreachable** | Serve **last-known-good** if any; else **allow** (fail open, parent §9). |
| Change-feed poll fails | Keep serving cached config; retry with backoff+jitter; §12.4 stale-while-revalidate. |

**Single-flight** guarantees at most one in-flight fetch per key per instance;
concurrent callers await it (parent §12.4). **Stale-while-revalidate** keeps
serving the old cap while one background refresh runs — the hot path never blocks
on a config fetch. An optional shared (Redis) config cache can sit between
instances and `quotamgmt` if per-instance cold-start load ever matters (parent
§6.2; future work, parent §18 decision 6).

### 5.6 Cache placement: SDK vs. service tier

Both are supported (parent §5); the trade-off:

| Placement | Pro | Con |
|-----------|-----|-----|
| **Service tier** (default) | Fewer distinct caches to warm; central change-feed poller; smaller producer footprint. | Config resolution costs the network hop (still ~0 ms extra since it's on the same request). |
| **SDK (co-located)** | Config resolution is fully in-process — lowest latency, survives service-tier outages for cap lookup. | N producer caches to warm; more change-feed pollers (or a shared snapshot push). |

Latency-critical or fail-open-sensitive producers opt into SDK-side caching;
everyone else uses the service tier.

---

## 6. Client SDK Internals

### 6.1 Deadline

Every call carries a gRPC deadline, a **single global 5 ms** (parent §9;
resolved in parent §18 decision 5 — no per-limit/per-producer tuning in this
version). gRPC propagates it natively; the service also honors it and abandons
the shard op if the remaining budget is gone. On breach the SDK returns the
fail-open result (allow for check; drop+retry for charge) and emits `fail_open`
tagged by cause=`deadline`.

### 6.2 Circuit breaker (per shard / endpoint)

A rolling-window breaker keyed by **target shard** (so one bad shard doesn't trip
enforcement for keys on healthy shards — parent §9 "only keys on that shard lose
enforcement"):

- **Closed** → normal calls.
- **Open** (after an error/timeout threshold) → **fail open locally with no
  network call**, for a cooldown; periodically emit a single **probe**.
- **Half-open** → limited probes; success closes it, following the **health-gated
  ramp** (0→100% over seconds) so a recovering shard isn't slammed by all N
  servers at once (parent §12.3).

Backoff on reconnects/probes uses **exponential backoff + full jitter**
(`sleep = rand(0, min(cap, base·2^attempt))`, parent §12.3) so the producer fleet
spreads its retries.

### 6.3 Fail-open logic

The **only** place the fail-open decision is made (parent §9):

```
result = call(op, key, ..., deadline)
switch:
  ok                          -> return result
  DEADLINE_EXCEEDED           -> metric(fail_open, cause=deadline);  allow / drop-charge
  UNAVAILABLE / transport err -> breaker.record(); metric(fail_open); allow / drop-charge
  DEGRADED (shard down)       -> metric(fail_open, cause=degraded);  allow
  INVALID_ARGUMENT (malformed)-> metric(bad_request); allow + log (never throw)
  CONFIG_MISS (unconfigured)  -> allow (unlimited)   // resolved server-side, §5.3
```

For **Check**, fail-open = `allowed=true`. For **Charge**, there is no request to
allow/deny (it runs post-processing); fail-open = record failure, optionally
enqueue a **bounded, un-deduped retry** (parent §7.2, §9) — a late retry may
double-count, which is bounded and self-corrects at reset. For **Refund**, same as
charge (best-effort).

### 6.4 Batching & coalescing

- **Batch API** (`CheckQuotaBatch`, `ChargeBatch`, parent §3.1): a producer that
  must touch a per-customer *and* a per-org limit sends both keys in one round
  trip, saving a hop. The service fans them to their (possibly different) shards
  and gathers results; per-key atomicity is preserved (each key is single-shard).
  **Each element of the batch response is identical in shape to the single-call
  response** — `{allowed?, remaining, limit, reset_at}` per key — because batched
  keys may have different windows/units and thus different reset times (§3.5).
  Cross-key all-or-nothing batching is out of scope this version (parent §18
  decision 4, with weighted/hierarchical limits) — results are independent
  per-key.
- **Coalescing** (read-only Check on hot keys): the SDK/service collapses
  concurrent identical `Check`s on the same key within a few-ms window into one
  store read and fans the result back out (parent §12.4). **`Charge`/`Refund` are
  never coalesced** — each must apply.

### 6.5 Optional token-lease / local bucket for hot keys

For the top few percent of keys by traffic (parent §8.3, §10), the SDK can **lease
a slice of quota** (e.g. 100 tokens) from the central counter via a single
`Charge`-of-lease, then serve checks/charges **locally** from the leased bucket,
periodically syncing and returning unused tokens. This collapses many central ops
into few:

- Cuts central QPS by the lease size → relieves the hot shard (§9.2).
- Trades accuracy: a crashing instance **loses its unused lease** (bounded
  over-count — those tokens are "spent" from the central view). Acceptable under
  approximate-accuracy + fail-open.
- **Opt-in and hot-key-scoped** — never the default, which stays direct-to-store
  and accurate (parent §8).

### 6.6 Config cache placement

Per §5.6 — the SDK may hold the read-through config cache for lowest-latency cap
resolution; default is the service-tier cache.

### 6.7 Connection pooling

The SDK holds a **bounded, reused** gRPC connection pool to the service tier
(never connection-per-op, parent §12.3), with backoff-with-jitter on reconnect and
jittered keepalive so the producer fleet doesn't reconnect in lockstep after a
service-tier deploy.

---

## 7. Concurrency & Atomicity

### 7.1 Single-key ops on a single-threaded shard

Each `Charge`/`Refund` is a read-modify-write that **must** be atomic (parent
§6.6). Two properties make it lock-free:

1. **A key lives on exactly one shard** (§4.3) — no cross-shard transaction.
2. **Redis executes each Lua script atomically on a single-threaded shard** — no
   other command interleaves. So `INCRBY`+conditional-`EXPIRE` (charge) and
   `DECRBY`+conditional-floor (refund) are indivisible with **no locks and no CAS
   retries** in the common path (parent §7.1).

`Check` is read-only (`GET`) and needs no atomicity beyond the single `GET`.

### 7.2 Overshoot into negative is intentional

Because `Check` does **not** reserve (parent §3.2, §6.4), N concurrent requests can
each pass the check at `consumed=999/limit=1000` and then all `Charge`, driving
`consumed` past the cap and `remaining` negative. This is **bounded by
concurrency**, and **subsequent checks correctly deny** until reset. We accept it
for a cheap, low-latency pre-flight (parent §6.4). Producers needing hard caps can
charge-then-check (reserve up front) at the cost of compensating refunds.

### 7.3 Replication & the refund/absent-key edges

- **Async replication** means a failover can lose the last few ms of charges →
  slight under-count, never a block (parent §7.3). Never synchronous in the hot
  path.
- **Refund with no prior charge / after reset:** `DECRBY` on a missing key creates
  it at `-amount`, which the floor immediately raises to `0`. The refund did not
  set a TTL (only `CHARGE` does), so a `0`-valued key with no TTL could linger —
  the next `CHARGE` sets the TTL, or a defensive `EXPIRE`-if-no-TTL can be added to
  `REFUND` if such keys prove common. The over-credit against a **new** window is
  floored and bounded (parent §6.5); the month case is accepted as-is (parent
  §18 decision 1).

---

## 8. Thundering Herd & Synchronization (data plane)

Expands parent §12 for the hot path. Two rules drive everything: **(a) never let a
large set of events fire at the same instant** (jitter), and **(b) never let N
servers stampede a recovering dependency** (bounded pools, backoff+jitter,
breakers, single-flight, stale-while-revalidate).

### 8.1 Synchronized TTL expiry → additive jitter

Every same-unit key would otherwise reach `TTL=0` at the boundary at once,
spiking active-expiry CPU and reclamation on the shard (parent §12.1). Mitigated
by the **strictly-additive TTL jitter** in §4.5 — smears reclamation over `J`,
harmless because the dead key is never read (reset is `window_id`-driven).

### 8.2 Boundary reset burst → phase offset + coalescing

At the boundary every throttled caller finds quota again → a synchronized burst of
allowed traffic **and** new-key writes on the same shards (parent §12.2). Mitigated
by the **per-key phase offset** (§4.6) spreading resets across the shard, plus
service-tier **request coalescing** on the read-only Check surge (§8.3). This is
the flip side of the fixed-window 2× burst (parent §6.1).

### 8.3 Redis/service connection storms → bounded pools + breakers

The service tier is N stateless servers on the same shards; a single dependency
event fans into N correlated reactions (parent §12.3). On failover/restart, all N
would reconnect at once → a connection/AUTH/topology-discovery storm that can
re-kill the recovered node. Data-plane mitigations (parent §12.3):

- **Bounded, reused connection pools** per server; never connection-per-op.
- **Reconnect with exponential backoff + full jitter** so N servers spread out.
- **Per-shard circuit breaker** → fail **open** on the data path while a shard is
  sick, probe with a trickle, ramp gradually.
- **Health-gated ramp** (0→100% over seconds) on a recovering shard.
- **Jittered topology + script-cache refresh** so servers don't all rediscover
  cluster topology / `SCRIPT LOAD` on the same tick (§4.2).

### 8.4 Cache stampedes (config dogpile) → jitter + single-flight + SWR

If a hot config entry expires everywhere at once, all N servers miss and hammer
`quotamgmt` (parent §12.4). Mitigations, per §5.5: **jittered cache TTLs**,
**single-flight** (one in-flight fetch per key per server), **stale-while-
revalidate** (serve old cap while one background refresh runs), and **push/feed
invalidation** so caches refresh on *change* not on a synchronized clock.

### 8.5 Hot-key check coalescing

Concurrent identical read-only `Check`s on one hot key within a few-ms window
collapse into **one** store read, fanned back out (parent §12.4, §8.3). Charges and
refunds are never coalesced.

---

## 9. Sharding, Hot Keys, Token Lease & the Degradation Ladder

### 9.1 Sharding recap

Consistent-hash / cluster-slot on the hash-tagged key; one key = one shard,
preserving atomicity; stateless service tier autoscaled behind a regional LB
(parent §10, §4.3). Capacity sketch: keys are ~100 B; 100 M active
`(customer,limit,window)` keys ≈ 10 GB — a modest cluster; TTLs keep only active
windows resident (parent §10, §14).

### 9.2 Hot-key / hot-shard mitigation

A single customer can concentrate traffic on one key → one shard hotspots, and the
key **can't** be split (atomicity needs one owner). Ladder of mitigations (parent
§10):

1. **Read coalescing** on `Check` (§8.5) — collapses read QPS first, no accuracy
   loss.
2. **Check-result caching** in the SDK (short TTL, e.g. 200 ms) — bounded
   staleness (parent §8.2). Charges never cached.
3. **Token lease / local bucket** (§6.5) — collapses *charge* QPS by the lease
   size; trades a bounded over-count for big shard relief.
4. **Hot-key read replication** — serve read-only `Check` from replicas (parent
   §10).
5. **Per-caller admission control** — one abuser can't starve the shard for others
   (parent §10, §16 fairness).

### 9.3 Degradation ladder (freshness → enforcement; never a cliff)

Under stress the system degrades along **documented, monotonic** axes; the product
always keeps serving, only enforcement *accuracy* loosens, and always **freshness
before enforcement** (parent §13):

```
 load ▲
      │ 4  Service tier saturating ─▶ autoscale; meanwhile deadlines trip,
      │                              SDKs fail open (allow).
      │ 3  Store CPU high still  ─▶ service returns DEGRADED; SDKs fail open.
      │                              Enforcement loosens per-shard, per-key.
      │ 2  Store CPU high        ─▶ shed Check FRESHNESS: serve short-TTL cached
      │                              decisions. Charge stays authoritative.
      │ 1  Store CPU rising      ─▶ escalate hot keys to token-lease mode,
      │                              collapsing central QPS (accuracy cost).
      └───────────────────────────────────────────────────────────────▶ accuracy loss
```

At every rung the **product keeps serving**; enforcement degrades predictably
(freshness first, then enforcement), never a cliff (parent §13). Charge is the
last thing to lose authority.

---

## 10. Fail-Open & Error-Handling Matrix

Fail-open is the **only** mode (parent §9); the sole producer knob is the deadline.
The SDK never throws into the request path (parent N5).

| Failure | Detected where | Data-plane behavior |
|---------|----------------|---------------------|
| **Deadline exceeded (> 5 ms)** | SDK | **Allow** (check) / record-drop-retry (charge). Emit `fail_open{cause=deadline}`. |
| **Service 5xx / `UNAVAILABLE` / unreachable** | SDK | **Allow**. Breaker records; opens after threshold → allow-all for cooldown, probe, health-gated ramp (§6.2). |
| **Counter shard down** | Service → typed `DEGRADED` | SDK **allows**. Only keys on that shard lose enforcement (per-shard breaker, §6.2). |
| **Config lookup fails** | Service / SDK cache | Serve **last-known-good** cap; if none, **allow** (unconfigured, §5.5). |
| **Config unconfigured (no row, no `'*'`)** | Service resolver | **Allow** (unlimited); brief **negative cache** (§5.3). |
| **Charge fails (post-processing)** | SDK | Bounded retry w/ backoff+jitter, then drop + metric. **Un-deduped** → late retry may double-count (bounded, self-corrects at reset; parent §7.2). Never blocks the product. |
| **Refund fails** | SDK | Best-effort retry then drop + metric; refund is advisory credit. |
| **Malformed request** (cost/key/batch caps) | Service validation | Typed `INVALID_ARGUMENT`; SDK treats as **allow + log**, never throws (parent §9, §16). |
| **`NOSCRIPT` (shard flushed script cache)** | Service | Fall back to `EVAL` once, re-`SCRIPT LOAD` (jittered), retry (§4.2). |
| **Redis async-replica failover** | Redis/service | Possible last-few-ms under-count; **allow-through**, never block (parent §7.3). |

---

## 11. Deployment

### 11.1 Regional, multi-AZ

- **One data-plane deployment per region**, enforcing quota using **only that
  region's traffic** (parent §11). A "1000/min" limit is enforced per-region;
  global caps are out of scope here — per-region only, no reconciliation
  (parent §11, §18 decision 2).
- **Multi-AZ within the region:** service-tier instances and Redis shards spread
  across AZs. Each shard's primary+replica sit in **different AZs** so an AZ loss
  fails a shard over rather than losing it (§4.4). The service tier prefers
  same-AZ shard/pool routing to shave RTT off the latency budget (§1.3), falling
  back cross-AZ on failure.

### 11.2 Redis topology

- **Redis Cluster**, N shards, each primary + ≥1 replica, async replication, RDB
  snapshots, AOF optional (§4.4). Sized to hold active windows with headroom
  (§9.1). Slots are hash-tagged per limit (§4.3).
- Managed or self-run; the design assumes standard Cluster semantics (slot
  ownership, `MOVED`/`ASK` redirection handled by the service's cluster-aware
  client, jittered topology refresh).

### 11.3 Autoscaling the stateless tier

- The RL Service tier autoscales on **CPU / QPS / p99 latency** behind the
  regional LB (parent §5, §10). Stateless → instances are killed/added freely.
- Scale-in respects the **connection-storm rules** (§8.3): drain with jittered
  connection close so producers don't all reconnect at once.
- Scales toward near-zero in quiet regions (parent §14 cost).

### 11.4 Config dependency

The data plane depends on `quotamgmt` only for **config reads** (cache miss +
change-feed poll, §5). It is decoupled by the cache and **fails open** if
`quotamgmt` is unavailable (§5.5). `quotaui` is **never** in the data path (parent
§5.1); it only consumes the read-only live-usage endpoint (§2.2).

---

## 12. Observability & SLOs

Metrics (parent §15), with the data-plane emphasis:

| Metric | Type | Why it matters |
|--------|------|----------------|
| **Client-observed latency p50/p99/p999** | histogram | The N1 SLO (**p99 ≤ 5 ms**, §1.3). Measured at the SDK. |
| **Fail-open rate** (by cause) | rate | **Key SLO** — high fail-open = we're *not actually limiting* (parent §15). Tagged `deadline / unavailable / degraded / config`. |
| Check / Charge / Refund QPS | rate | Load & mix. |
| Allow / deny (429) rate | rate | Enforcement effectiveness; per-customer/limit views. |
| **Per-shard load** (ops, CPU, mem, expiry rate) | gauge | Hot-shard detection; expiry rate should be **smooth** (jitter working, §8.1). |
| **Hot-key list** | top-K | Drives escalation to coalesce/cache/lease (§9.2). |
| **Negative-quota incidence** | rate | How often overshoot pushes `remaining < 0` (parent §6.4) — expected, but a spike signals concurrency issues. |
| Config cache hit/miss, single-flight coalesce, stampede count | rate | Dogpile health (§8.4). |
| Redis reconnect rate, backoff attempts, pool saturation | rate/gauge | Connection-storm health (§8.3). |
| Token-lease over-count (leased-but-lost) | rate | Accuracy cost of §6.5. |

- **Tracing:** propagate the caller's trace context and `request_id` through
  check/charge/refund (logging/tracing only, parent §7.2, §15).
- **Alerts:** fail-open rate over threshold; shard hotspots; replication lag;
  config-propagation lag; correlated expiry/reconnect spikes (parent §15).

**Primary SLOs:** (1) client-observed p99 ≤ 5 ms; (2) fail-open rate under target
(e.g. < 0.1% steady-state) — a limiter that fails open constantly isn't limiting.

---

## 13. Testing & Rollout

Follows the parent rollout (parent §19) for the data-plane slice:

1. **Correctness / unit** — the three Lua scripts against a real Redis:
   charge→negative, refund floor-at-0 **with TTL preserved** (assert TTL unchanged
   after floor — the `INCRBY`-not-`SET` invariant, §4.2), TTL-set-once,
   missing-key=`consumed 0`, `window_id` math incl. **month calendar boundaries**
   and leap years, and the phase-offset variant.
2. **Concurrency** — hammer one key with concurrent charges; assert bounded
   overshoot and correct deny-after-cap (§7.2); assert atomicity (no lost
   updates).
3. **Fail-open** — inject timeouts, shard-down, `NOSCRIPT`, config-unavailable,
   malformed input; assert **allow** every time and that the SDK never throws
   (§10). Chaos: kill a shard, kill `quotamgmt`, partition an AZ.
4. **Herd** — synchronized-boundary load test; assert expiry rate stays smooth
   (jitter, §8.1), no connection storm on forced failover (§8.3), no config
   dogpile on synchronized cache expiry (§8.4).
5. **Load / capacity** — verify p99 ≤ 5 ms at target QPS and the capacity sketch
   (§9.1); find the hot-shard knee and validate the degradation ladder rungs fire
   in order (§9.3).
6. **Shadow mode** — producers call the limiter but **never enforce**: record the
   allow/deny we *would* have made and compare against reality to validate accuracy
   and the config resolution before turning on enforcement (parent §19.3). This is
   the gate before any real 429s.
7. **Rollout** — enable enforcement **per limit** with fail-open default; start
   with a low-risk limit; watch fail-open rate and 429s; then hot-key escalation
   (caching, token lease); then additional regions (parent §19).

---

## 14. Cross-References

- **Parent** `regional-rate-limiter-design.md`: overall architecture (§5), API
  (§3), core algorithm (§6), concurrency (§7), latency/caching (§8), failure
  handling (§9), sharding (§10), regional model (§11), thundering herd (§12),
  degradation (§13), observability (§15), and the Redis/Postgres schemas
  (Appendix B).
- **`quotamgmt`** (control plane): source of truth for config; serves the
  read-through cap resolution (§5), the audit change-feed (§5.4), and CRUD/defaults
  authoring. The data plane is a read-only consumer.
- **`quotaui`** (admin UI): control-plane client only; consumes this component's
  **read-only live-usage endpoint** (§2.2) and never touches Redis or the hot path
  (parent §5.1).
- **`schema/redis_scripts.lua`**: the authoritative charge/refund/check scripts
  (§4.2).
- **`schema/postgres.sql`**: the config/audit schema the cap resolution and
  change-feed read against (§5).
