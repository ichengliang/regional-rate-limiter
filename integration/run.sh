#!/usr/bin/env bash
# One-shot runner: venv + proto stubs + pytest. The pytest fixtures bring the
# compose infra up/down and build+start the services, so this is all you need.
#
#   ./run.sh                 # full suite
#   ./run.sh -k propagation  # subset (pytest args pass through)
#   KEEP_INFRA=1 ./run.sh    # leave Postgres/Redis running for fast reruns
set -euo pipefail
cd "$(dirname "$0")"

PROTO_ROOT=../proto

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

echo "→ running integration tests"
exec ./.venv/bin/python -m pytest "$@"
