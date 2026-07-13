#!/usr/bin/env bash
# Build the three service images (build context = repo root) and push to Artifact
# Registry. Runs locally; needs Docker.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker gcloud terraform
load_env

log "Configuring docker auth for ${REGISTRY%%/*} ..."
gcloud auth configure-docker "${REGISTRY%%/*}" --quiet

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
