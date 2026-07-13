#!/usr/bin/env bash
# Seed a demo service + limits into quotamgmt (over its external gRPC LB, via
# reflection). Idempotent-ish: re-creating an existing limit just reports it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd grpcurl kubectl

ADDR="${QUOTAMGMT_ADDR:-$(lb_ip quotamgmt):8443}"
TOKEN="${QUOTAMGMT_TOKEN:-$QUOTAMGMT_DEV_TOKEN}"
AUTH=(-H "authorization: Bearer $TOKEN")
log "Seeding via quotamgmt @ $ADDR"

call() { # method json
  grpcurl -plaintext "${AUTH[@]}" -d "$2" "$ADDR" "quotamgmt.v1.LimitAdmin/$1" \
    || warn "$1 returned non-zero (already exists?) — continuing"
}

call RegisterService '{"service":{"service_name":"search-svc","display_name":"Search Service","owner":"demo"}}'
# Default for every customer of search-svc: 100 req/min, 1000 req/day.
call CreateLimit '{"key":{"service_name":"search-svc","customer_id":"*","rate_limit_id":"requests_per_min"},"limit_value":100,"time_unit":"MINUTE"}'
call CreateLimit '{"key":{"service_name":"search-svc","customer_id":"*","rate_limit_id":"requests_per_day"},"limit_value":1000,"time_unit":"DAY"}'
# Exact override for one noisy customer: only 5 req/min (easy to exhaust in a demo).
call CreateLimit '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"limit_value":5,"time_unit":"MINUTE"}'

log "Seed complete. Try:"
cat <<EOF
  grpcurl -plaintext -d '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"cost":1}' \\
    ${QUOTAENFORCER_ADDR:-<enforcer-ip>:8444} quotaenforcer.v1.RateLimiter/CheckQuota
EOF
