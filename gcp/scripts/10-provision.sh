#!/usr/bin/env bash
# Provision all GCP infra with Terraform, then point kubectl at the cluster.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd terraform gcloud kubectl

[ -f "$TF_DIR/terraform.tfvars" ] \
  || die "create $TF_DIR/terraform.tfvars first (copy terraform.tfvars.example, set project_id)."

log "terraform init..."
terraform -chdir="$TF_DIR" init -input=false

log "terraform apply (VPC, private services, GKE, Cloud SQL, Memorystore, Artifact Registry)..."
terraform -chdir="$TF_DIR" apply -input=false "${@:--auto-approve}"

log "Fetching kubectl credentials..."
eval "$(tf_out gke_get_credentials_cmd)"

log "Provision complete. Cluster: $(tf_out cluster_name)"
