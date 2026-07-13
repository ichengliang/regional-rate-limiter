#!/usr/bin/env bash
# One-command teardown — the symmetric counterpart to up.sh. Deletes the k8s
# namespace (which frees the external LoadBalancers) and then destroys all GCP
# infra with Terraform. Thin wrapper around 90-teardown.sh; args pass through
# (e.g. `./down.sh` for auto-approve, or pass your own terraform destroy flags).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
log "Tearing down the GCP deployment (namespace + all Terraform-managed infra)..."
exec "$SCRIPT_DIR/90-teardown.sh" "$@"
