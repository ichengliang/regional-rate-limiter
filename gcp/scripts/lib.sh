#!/usr/bin/env bash
# Shared helpers for the GCP deploy scripts. Sourced by the others; runs locally.
set -euo pipefail

# --- paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$GCP_DIR/.." && pwd)"
TF_DIR="$GCP_DIR/terraform"
K8S_DIR="$GCP_DIR/k8s"
RENDER_DIR="$GCP_DIR/.rendered"   # gitignored: manifests with values filled in

# --- knobs (override via env) ---
NAMESPACE="${NAMESPACE:-quota}"
IMAGE_TAG="${IMAGE_TAG:-$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo dev)}"
# Stable dev platform-admin token shared by quotamgmt, the BFF, seed, and tests.
QUOTAMGMT_DEV_TOKEN="${QUOTAMGMT_DEV_TOKEN:-quota-demo-admin-token}"

# The exact set of placeholders envsubst is allowed to touch, so shell `$VAR`
# and `$(...)` inside the manifests (e.g. the db-init job) are left intact.
SUBST_VARS='${NAMESPACE} ${DB_PRIVATE_IP} ${DB_NAME} ${DB_USER} ${DB_PASSWORD} ${REDIS_AUTH} ${REDIS_HOST} ${REDIS_PORT} ${QUOTAMGMT_DEV_TOKEN} ${IMAGE_QUOTAMGMT} ${IMAGE_QUOTAENFORCER} ${IMAGE_QUOTAUI}'

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found on PATH: $c"
  done
}

tf_out() { terraform -chdir="$TF_DIR" output -raw "$1"; }

# Export all values the manifests / scripts need, from Terraform outputs.
load_env() {
  require_cmd terraform
  [ -f "$TF_DIR/terraform.tfstate" ] || [ -n "${TF_HAS_REMOTE_STATE:-}" ] \
    || warn "no local terraform state in $TF_DIR — did you run 10-provision.sh?"
  export REGION="$(tf_out region)"
  export CLUSTER_NAME="$(tf_out cluster_name)"
  export REGISTRY="$(tf_out artifact_registry_repo)"
  export DB_PRIVATE_IP="$(tf_out db_private_ip)"
  export DB_NAME="$(tf_out db_name)"
  export DB_USER="$(tf_out db_user)"
  export DB_PASSWORD="$(tf_out db_password)"
  export REDIS_HOST="$(tf_out redis_host)"
  export REDIS_PORT="$(tf_out redis_port)"
  export REDIS_AUTH="$(tf_out redis_auth)"
  export IMAGE_QUOTAMGMT="$REGISTRY/quotamgmt:$IMAGE_TAG"
  export IMAGE_QUOTAENFORCER="$REGISTRY/quotaenforcer:$IMAGE_TAG"
  export IMAGE_QUOTAUI="$REGISTRY/quotaui:$IMAGE_TAG"
  export NAMESPACE QUOTAMGMT_DEV_TOKEN
}

# Wait for a Service to be assigned an external LB IP, echo it.
lb_ip() {
  local svc="$1" ip=""
  for _ in $(seq 1 60); do
    ip="$(kubectl -n "$NAMESPACE" get svc "$svc" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    [ -n "$ip" ] && { echo "$ip"; return 0; }
    sleep 10
  done
  return 1
}
