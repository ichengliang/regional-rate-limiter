#!/usr/bin/env bash
# Manual load generator to demonstrate the enforcer HPA scaling 3 -> 10.
# Fires concurrent CheckQuota calls at the data-plane LB. Watch scaling with:
#   watch kubectl -n quota get hpa,pods -l app=quotaenforcer
#
#   ./loadgen.sh                 # 64 workers, 120s (auto-discovers endpoint)
#   WORKERS=128 DURATION=300 ./loadgen.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd grpcurl kubectl

ADDR="${QUOTAENFORCER_ADDR:-$(lb_ip quotaenforcer):8444}"
WORKERS="${WORKERS:-64}"
DURATION="${DURATION:-120}"
log "Hammering $ADDR with $WORKERS workers for ${DURATION}s"

end=$(( $(date +%s) + DURATION ))
worker() {
  local w="$1" i=0
  while [ "$(date +%s)" -lt "$end" ]; do
    grpcurl -plaintext -d "{\"key\":{\"service_name\":\"loadtest\",\"customer_id\":\"$w-$((i%500))\",\"rate_limit_id\":\"rpm\"},\"cost\":1}" \
      "$ADDR" quotaenforcer.v1.RateLimiter/CheckQuota >/dev/null 2>&1
    i=$((i+1))
  done
}
for w in $(seq 1 "$WORKERS"); do worker "$w" & done
wait
log "Load finished. Check: kubectl -n $NAMESPACE get hpa quotaenforcer"
