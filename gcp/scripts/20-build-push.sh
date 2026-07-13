#!/usr/bin/env bash
# Build the three service images (build context = repo root) and push to Artifact
# Registry. Runs locally; needs Docker.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker gcloud terraform
load_env

REGISTRY_HOST="${REGISTRY%%/*}"
log "Authenticating docker to $REGISTRY_HOST ..."
# Install the credential helper AND do a direct token login. The token login is
# the reliable path — it doesn't depend on the helper being on PATH or on which
# ~/.docker/config.json docker reads (e.g. under sudo).
gcloud auth configure-docker "$REGISTRY_HOST" --quiet
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY_HOST" \
  || die "docker login to $REGISTRY_HOST failed — is 'gcloud auth login' done and does the account have roles/artifactregistry.writer? (also: don't run this under sudo)"

build_push() {
  local name="$1" dockerfile="$2" image="$3"
  log "Building $name -> $image"
  docker build -f "$REPO_ROOT/$dockerfile" -t "$image" "$REPO_ROOT"
  log "Pushing $image"
  docker push "$image"
}

build_push quotamgmt     quotamgmt/Dockerfile     "$IMAGE_QUOTAMGMT"
build_push quotaenforcer quotaenforcer/Dockerfile "$IMAGE_QUOTAENFORCER"
build_push quotaui       quotaui/Dockerfile       "$IMAGE_QUOTAUI"

log "All images pushed at tag: $IMAGE_TAG"
