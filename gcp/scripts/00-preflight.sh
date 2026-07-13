#!/usr/bin/env bash
# Verify local tooling and GCP auth before anything is provisioned.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

log "Checking local tools..."
require_cmd gcloud kubectl terraform docker envsubst grpcurl python3

log "Checking gcloud auth..."
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "no active gcloud account — run: gcloud auth login && gcloud auth application-default login"

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
log "Active account: ${ACCOUNT:-<none>}"
log "Default project: ${PROJECT:-<none>  (set via terraform.tfvars project_id)}"

if [ ! -f "$TF_DIR/terraform.tfvars" ]; then
  warn "no $TF_DIR/terraform.tfvars — copy terraform.tfvars.example and set project_id."
fi

log "Preflight OK."
