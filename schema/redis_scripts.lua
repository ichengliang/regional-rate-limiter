-- Regional Rate Limiter — data-plane atomic ops (source of truth for counters).
-- Redis, run server-side (EVALSHA) on the key's owning shard.
-- See regional-rate-limiter-design.md Appendix B.2.
--
-- Key layout:
--   counter :  rl:{<svc>|<cust>|<rlid>}:cnt:<window_id>  -> String(int64) consumed
--
-- No server-side idempotency/dedup: it would cost one extra key per request and
-- balloon memory. `request_id` is carried by the RL service for logging/tracing
-- only. A retried charge/refund therefore re-applies — accepted under the
-- fail-open, approximate-accuracy philosophy (see §7.2).
--
-- The server computes window_id, the jittered TTL, and resolves `limit` from
-- config, then passes them in — keeping these scripts deterministic.

-- ============================================================
-- CHARGE  (always applies; remaining may go negative by design)
--   KEYS[1] = counter
--   ARGV[1] = cost   ARGV[2] = limit   ARGV[3] = ttl_seconds
--   returns remaining
-- ============================================================
local CHARGE = [[
local consumed = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if redis.call('TTL', KEYS[1]) < 0 then            -- brand-new window key
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))   -- set jittered TTL once
end
return tonumber(ARGV[2]) - consumed               -- may be negative (by design)
]]

-- ============================================================
-- REFUND  (floored at 0; uses INCRBY not SET to PRESERVE the window TTL)
--   KEYS[1] = counter
--   ARGV[1] = amount   ARGV[2] = limit
--   returns remaining
-- ============================================================
local REFUND = [[
local consumed = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if consumed < 0 then
    redis.call('INCRBY', KEYS[1], -consumed)      -- back to 0, TTL preserved
    consumed = 0
end
return tonumber(ARGV[2]) - consumed
]]

-- ============================================================
-- CHECK  (read-only)
--   KEYS[1] = counter   ARGV[1] = limit   ARGV[2] = cost
--   returns { allowed(1/0), remaining }
-- ============================================================
local CHECK = [[
local consumed  = tonumber(redis.call('GET', KEYS[1]) or '0')
local remaining = tonumber(ARGV[1]) - consumed
return { (remaining >= tonumber(ARGV[2])) and 1 or 0, remaining }
]]

return { charge = CHARGE, refund = REFUND, check = CHECK }
