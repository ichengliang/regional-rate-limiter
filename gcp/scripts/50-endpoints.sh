#!/usr/bin/env bash
# Print the external LoadBalancer endpoints (waits for IP assignment).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd kubectl

log "Resolving external LoadBalancer IPs (may take a minute on first deploy)..."
QM_IP="$(lb_ip quotamgmt)"     || die "quotamgmt LB IP not ready"
QE_IP="$(lb_ip quotaenforcer)" || die "quotaenforcer LB IP not ready"
UI_IP="$(lb_ip quotaui)"       || die "quotaui LB IP not ready"

cat <<EOF

  quotamgmt      (gRPC)  ${QM_IP}:8443
  quotaenforcer  (gRPC)  ${QE_IP}:8444
  quotaui        (HTTP)  http://${UI_IP}/

  Export for the seed + e2e scripts:
    export QUOTAMGMT_ADDR=${QM_IP}:8443
    export QUOTAENFORCER_ADDR=${QE_IP}:8444
    export QUOTAUI_URL=http://${UI_IP}
    export QUOTAMGMT_TOKEN=${QUOTAMGMT_DEV_TOKEN}
EOF
