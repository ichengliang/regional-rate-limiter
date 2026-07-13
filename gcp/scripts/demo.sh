#!/usr/bin/env bash
# Guided, step-by-step playground for the LIVE GCP deployment. Prints each command
# before running it and pauses between steps so you can follow along. It drives the
# real external load balancers exactly as a client would.
#
#   ./demo.sh              # interactive: press Enter between steps
#   DEMO_YES=1 ./demo.sh   # run straight through (no pauses)
#
# Endpoints are auto-discovered from the cluster (kubectl) unless you export
# QUOTAMGMT_ADDR / QUOTAENFORCER_ADDR / QUOTAUI_URL / QUOTAMGMT_TOKEN yourself.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd grpcurl curl kubectl

# --- resolve endpoints (env override, else discover the LB IPs) ---
QM_ADDR="${QUOTAMGMT_ADDR:-$(lb_ip quotamgmt):8443}"
QE_ADDR="${QUOTAENFORCER_ADDR:-$(lb_ip quotaenforcer):8444}"
QUI_URL="${QUOTAUI_URL:-http://$(lb_ip quotaui)}"
TOKEN="${QUOTAMGMT_TOKEN:-$QUOTAMGMT_DEV_TOKEN}"
AUTHH="authorization: Bearer $TOKEN"
[ -n "${QM_ADDR%%:}" ] && [ -n "${QE_ADDR%%:}" ] && [ -n "$QUI_URL" ] || die "could not resolve endpoints"

# A demo service/customer used throughout (safe to re-run — creates are tolerated).
SVC=playground; CUST=acme; RLID=rpm
KEY="{\"service_name\":\"$SVC\",\"customer_id\":\"$CUST\",\"rate_limit_id\":\"$RLID\"}"

pause() {
  echo
  printf '\033[1;36m══ %s ══\033[0m\n' "$1"
  [ -n "${DEMO_YES:-}" ] || read -rp $'\033[2m   (press Enter to run this step, Ctrl-C to stop)\033[0m '
}
run() { printf '\033[2m$ %s\033[0m\n' "$*"; "$@"; echo; }
QM() { run grpcurl -plaintext -H "$AUTHH" -d "$2" "$QM_ADDR" "quotamgmt.v1.LimitAdmin/$1"; }
QE() { run grpcurl -plaintext            -d "$2" "$QE_ADDR" "quotaenforcer.v1.RateLimiter/$1"; }

set +e  # forgiving: a single non-zero (e.g. ALREADY_EXISTS, a denied check) won't abort

cat <<EOF

  Regional Rate Limiter — GCP playground
  --------------------------------------
  quotamgmt      (gRPC)  $QM_ADDR
  quotaenforcer  (gRPC)  $QE_ADDR
  quotaui        (HTTP)  $QUI_URL
  admin token           $TOKEN
EOF

pause "1/9  Control plane is reachable — list registered services"
QM ListServices '{"page_size":10}'

pause "2/9  Register a demo service and a 5-requests/minute limit for customer '$CUST'"
QM RegisterService "{\"service\":{\"service_name\":\"$SVC\",\"display_name\":\"Playground\",\"owner\":\"demo\"}}"
QM CreateLimit "{\"key\":$KEY,\"limit_value\":5,\"time_unit\":\"MINUTE\"}"

pause "3/9  Wait for the new limit to reach the data plane (~5s propagation), then CheckQuota"
for _ in $(seq 1 15); do
  out=$(grpcurl -plaintext -d "{\"key\":$KEY,\"cost\":1}" "$QE_ADDR" quotaenforcer.v1.RateLimiter/CheckQuota 2>/dev/null)
  echo "$out" | grep -q '"limit": "5"' && break
  sleep 1
done
QE CheckQuota "{\"key\":$KEY,\"cost\":1}"      # allowed=true, remaining=5, limit=5

pause "4/9  Spend the whole budget: Charge cost 5 → remaining 0"
QE Charge "{\"key\":$KEY,\"cost\":5}"

pause "5/9  Now a CheckQuota is DENIED (grpcurl omits allowed=false; note remaining 0)"
QE CheckQuota "{\"key\":$KEY,\"cost\":1}"

pause "6/9  Live usage: consumed 5 of 5"
QE GetUsage "{\"key\":$KEY}"

pause "7/9  Refund 5 → capacity restored, checks allowed again"
QE Refund "{\"key\":$KEY,\"amount\":5}"
QE CheckQuota "{\"key\":$KEY,\"cost\":1}"

pause "8/9  quotaui admin console (BFF): log in as operator 'alice' and read the config + live usage"
CJ=$(mktemp)
run curl -s -c "$CJ" -X POST "$QUI_URL/api/auth/login" -H 'content-type: application/json' -d '{"user":"alice"}'
run curl -s -b "$CJ" "$QUI_URL/api/limits?service_name=$SVC"
run curl -s -b "$CJ" "$QUI_URL/api/usage?service_name=$SVC&customer_id=$CUST&rate_limit_id=$RLID"
rm -f "$CJ"

pause "9/9  High availability: 3 replicas per service, and the enforcer HPA (3→10)"
run kubectl -n "$NAMESPACE" get deploy
run kubectl -n "$NAMESPACE" get hpa quotaenforcer

echo
log "Playground complete. Open the UI in a browser: $QUI_URL"
log "Tip: try exhausting the limit again, or edit it in the UI. Tear down with ./down.sh."
