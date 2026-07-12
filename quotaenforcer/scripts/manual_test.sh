#!/usr/bin/env bash
# Manual verification of quotaenforcer over gRPC.
#
# Prereqs:
#   - Server running (default 127.0.0.1:8444) with Redis + Postgres reachable.
#   - grpcurl on PATH (or set GRPCURL=/path/to/grpcurl). The server exposes gRPC
#     server reflection, so no local .proto files are needed.
#   - Config seeded: run `SEED=1 ./scripts/manual_test.sh`, or seed once with
#       psql -f scripts/seed.sql   (PG* env from the repo .env)
#
# Env knobs:  ADDR (127.0.0.1:8444)  GRPCURL (grpcurl)  SEED (unset)
#
# Each case prints WHAT it checks and EXPECT before running the call.
# Reading note: grpcurl omits proto3 zero/false fields — a MISSING field means
# the default (e.g. no "allowed" => allowed=false; empty {} => all zero/false).
set -u

ADDR="${ADDR:-127.0.0.1:8444}"
GRPCURL="${GRPCURL:-grpcurl}"
SVC="quotaenforcer.v1.RateLimiter"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v "$GRPCURL" >/dev/null 2>&1; then
  echo "ERROR: grpcurl not found. Install it or set GRPCURL=/path/to/grpcurl." >&2
  echo "  e.g. https://github.com/fullstorydev/grpcurl/releases" >&2
  exit 1
fi

if [ "${SEED:-}" = "1" ]; then
  echo "Seeding config (scripts/seed.sql) ..."
  psql -v ON_ERROR_STOP=1 -f "$HERE/seed.sql" >/dev/null || {
    echo "ERROR: seed failed (check PG* env / .env)." >&2; exit 1; }
fi

call() { "$GRPCURL" -plaintext -d "$2" "$ADDR" "$SVC/$1" 2>&1; }
hr()   { printf '\n\033[1;36m── %s ─────────────────────────────\033[0m\n' "$1"; }
note() { printf '   \033[2m%s\033[0m\n' "$1"; }

# Reset counters so the mutation cases are deterministic (counters are ephemeral).
redis-cli --scan --pattern 'rl:{search-svc|*' | xargs -r redis-cli del >/dev/null 2>&1

hr "1. CheckQuota — fresh window, quota available"
note "EXPECT: allowed=true, remaining=1000, limit=1000, resetAt=next :00"
call CheckQuota '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":1}'

hr "2. Charge — applied after processing (cost 3)"
note "EXPECT: remaining=997, limit=1000"
call Charge '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":3,"request_id":"req_a1b2c3"}'

hr "3. GetUsage — live usage (read-only; used by quotaui)"
note "EXPECT: consumed=3, remaining=997, limit=1000, configured=true"
call GetUsage '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"}}'

hr "4. Refund — credit the 3 back"
note "EXPECT: remaining=1000, limit=1000"
call Refund '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"amount":3,"request_id":"req_a1b2c3"}'

hr "5. Charge — cost defaults to 1 when omitted"
note "EXPECT: remaining=999 (limit 1000 - 1)"
call Charge '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"}}'

hr "6. CheckQuota — '*' default applies to an unlisted customer"
note "EXPECT: allowed=true, limit=100 (the '*' default, NOT 1000)"
call CheckQuota '{"key":{"service_name":"search-svc","customer_id":"brand_new_customer","rate_limit_id":"requests_per_min"},"cost":1}'

hr "7. CheckQuota — exact customer row wins over '*' default"
note "EXPECT: limit=1000 (cust_42 exact row, not the 100 default)"
call CheckQuota '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":1}'

hr "8. Charge past the cap → remaining goes NEGATIVE (by design)"
note "EXPECT: remaining < 0 (charge 150 against the 100 default)"
call Charge '{"key":{"service_name":"search-svc","customer_id":"brand_new_customer","rate_limit_id":"requests_per_min"},"cost":150}'

hr "9. CheckQuota — now DENIED (maps to HTTP 429 at the producer)"
note "EXPECT: allowed=false (field omitted), remaining negative"
call CheckQuota '{"key":{"service_name":"search-svc","customer_id":"brand_new_customer","rate_limit_id":"requests_per_min"},"cost":1}'

hr "10. CheckQuotaBatch — minute limit + day limit in one round trip"
note "EXPECT: 2 results with DIFFERENT resetAt (minute vs next UTC midnight); org limit=50000"
call CheckQuotaBatch '{"requests":[
  {"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":1},
  {"key":{"service_name":"search-svc","customer_id":"org_9","rate_limit_id":"org_tokens_per_day"},"cost":500}
]}'

hr "11. Unconfigured limit → ALLOW / unlimited (fail-open)"
note "EXPECT: allowed=true, limit=0 (no row, no '*' default => unlimited)"
call CheckQuota '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"never_configured"},"cost":1}'

hr "12. GetUsage — unconfigured reports configured=false"
note "EXPECT: {} (consumed=0, remaining=0, limit=0, configured=false — all omitted)"
call GetUsage '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"never_configured"}}'

hr "13. Invalid argument — missing key"
note "EXPECT: ERROR InvalidArgument (key is required)"
call CheckQuota '{"cost":1}'

hr "14. Invalid argument — negative cost"
note "EXPECT: ERROR InvalidArgument (cost must be >= 0)"
call CheckQuota '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":-5}'

hr "DONE"
