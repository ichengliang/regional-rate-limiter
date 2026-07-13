#!/usr/bin/env bash
# Tear everything down. Deletes the k8s namespace FIRST (so GCP frees the LB
# forwarding rules) before destroying the VPC/infra with Terraform.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd kubectl terraform

if kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  log "Deleting namespace $NAMESPACE (releases external LoadBalancers)..."
  kubectl delete ns "$NAMESPACE" --wait=true || warn "namespace delete had issues"
  log "Waiting for LB resources to be released..."
  sleep 30
fi

log "terraform destroy..."
terraform -chdir="$TF_DIR" destroy -input=false "${@:--auto-approve}"

rm -rf "$RENDER_DIR"
log "Teardown complete."
