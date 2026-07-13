#!/usr/bin/env bash
# One-command bring-up: preflight -> provision -> build/push -> deploy -> seed.
# Each step is also runnable on its own (see the numbered scripts).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

"$SCRIPT_DIR/00-preflight.sh"
"$SCRIPT_DIR/10-provision.sh" -auto-approve
"$SCRIPT_DIR/20-build-push.sh"
"$SCRIPT_DIR/30-deploy.sh"
"$SCRIPT_DIR/40-seed.sh"

log "Stack is up. Run the e2e suite:  cd $GCP_DIR/e2e && ./run.sh"
