#!/usr/bin/env bash
# Render manifests from Terraform outputs and deploy to GKE: config/secret, load
# the DB schema (in-cluster job, since Cloud SQL is private), then the 3 services.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd kubectl terraform envsubst gcloud
load_env

log "Pointing kubectl at the cluster..."
eval "$(tf_out gke_get_credentials_cmd)"

log "Rendering manifests -> $RENDER_DIR"
rm -rf "$RENDER_DIR"; mkdir -p "$RENDER_DIR"
for f in "$K8S_DIR"/*.yaml; do
  envsubst "$SUBST_VARS" < "$f" > "$RENDER_DIR/$(basename "$f")"
done

log "Namespace + config + secret..."
kubectl apply -f "$RENDER_DIR/00-namespace.yaml"
kubectl apply -f "$RENDER_DIR/10-config.yaml"
kubectl apply -f "$RENDER_DIR/11-secret.yaml"

log "Publishing schema as a ConfigMap..."
kubectl -n "$NAMESPACE" create configmap quota-schema \
  --from-file=postgres.sql="$REPO_ROOT/schema/postgres.sql" \
  --dry-run=client -o yaml | kubectl apply -f -

log "Running db-init job (loads schema into private Cloud SQL)..."
kubectl -n "$NAMESPACE" delete job db-init --ignore-not-found
kubectl apply -f "$RENDER_DIR/20-db-init-job.yaml"
kubectl -n "$NAMESPACE" wait --for=condition=complete job/db-init --timeout=300s \
  || { kubectl -n "$NAMESPACE" logs job/db-init || true; die "db-init failed"; }
kubectl -n "$NAMESPACE" logs job/db-init || true

log "Deploying services (3 replicas each; enforcer HPA 3->10)..."
kubectl apply -f "$RENDER_DIR/30-quotamgmt.yaml"
kubectl apply -f "$RENDER_DIR/40-quotaenforcer.yaml"
kubectl apply -f "$RENDER_DIR/50-quotaui.yaml"

log "Waiting for rollouts..."
for d in quotamgmt quotaenforcer quotaui; do
  kubectl -n "$NAMESPACE" rollout status deploy/"$d" --timeout=300s
done

log "Deploy complete."
"$SCRIPT_DIR/50-endpoints.sh"
