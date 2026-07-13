#!/usr/bin/env bash
# Local runner for the e2e suite against the DEPLOYED GKE stack.
#
# Endpoints come from env (see `scripts/50-endpoints.sh` output). If they are
# unset and kubectl points at the cluster, they are auto-discovered.
#
#   ./run.sh                 # core suite
#   ./run.sh -k enforcement  # subset (pytest args pass through)
#   ./run.sh -m slow         # HPA scale-up test only
#   ./run.sh -m ""           # everything incl. slow
set -euo pipefail
cd "$(dirname "$0")"

PROTO_ROOT=../../proto

# --- auto-discover LB endpoints from the cluster if not provided ---
if [ -z "${QUOTAMGMT_ADDR:-}" ] && command -v kubectl >/dev/null 2>&1; then
  NS="${NAMESPACE:-quota}"
  ip() { kubectl -n "$NS" get svc "$1" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true; }
  QM="$(ip quotamgmt)"; QE="$(ip quotaenforcer)"; UI="$(ip quotaui)"
  [ -n "$QM" ] && export QUOTAMGMT_ADDR="$QM:8443"
  [ -n "$QE" ] && export QUOTAENFORCER_ADDR="$QE:8444"
  [ -n "$UI" ] && export QUOTAUI_URL="http://$UI"
  echo "→ discovered endpoints: qm=${QUOTAMGMT_ADDR:-?} qe=${QUOTAENFORCER_ADDR:-?} ui=${QUOTAUI_URL:-?}"
fi

if [ ! -d .venv ]; then
  echo "→ creating venv"
  python3 -m venv .venv
fi
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt

echo "→ generating proto stubs"
mkdir -p gen
./.venv/bin/python -m grpc_tools.protoc -I"$PROTO_ROOT" \
  --python_out=gen --grpc_python_out=gen \
  quota/common/v1/common.proto \
  quotamgmt/v1/limit_admin.proto \
  quotaenforcer/v1/rate_limiter.proto

echo "→ running e2e tests"
exec ./.venv/bin/python -m pytest "$@"
