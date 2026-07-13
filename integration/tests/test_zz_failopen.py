"""Fail-open across the seam: when the config source (Postgres) is unreachable,
quotaenforcer must keep serving — allowing rather than blocking the product
(design §5.5, §9/§10). Runs last (zz) and always restarts Postgres afterwards.

Note: this repo's quotaenforcer reads Postgres directly for config, so "quotamgmt
/ config store unavailable" is exercised here by stopping the Postgres container.
"""

import pathlib
import subprocess
import time

import pytest

HERE = pathlib.Path(__file__).parent.parent


def _compose(*args):
    subprocess.run(
        ["docker", "compose", *args], cwd=HERE, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )


def _await_pg_healthy(timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        out = subprocess.run(
            ["docker", "compose", "ps", "--format", "{{.Service}}:{{.Health}}"],
            cwd=HERE, capture_output=True, text=True,
        ).stdout
        if "postgres:healthy" in out:
            return
        time.sleep(1)
    raise RuntimeError("postgres did not become healthy again")


def test_config_store_down_fails_open(qm, qe, api, svc_name):
    # Sanity: service reachable, config store up.
    api.register_service(qm, svc_name)

    _compose("stop", "postgres")
    try:
        # A brand-new (uncached) limit lookup can't reach config → fail OPEN:
        # allow, treated as unlimited (limit 0), never a block/deny.
        r = api.check(qe, svc_name, "cust", "uncached_while_pg_down")
        assert r.allowed is True, "must allow when config store is unreachable"
        assert r.limit == 0
    finally:
        _compose("start", "postgres")
        _await_pg_healthy()
        # Give the pooled connections a moment to re-establish.
        time.sleep(2)

    # Recovered: config resolution works again end-to-end.
    api.create_limit(qm, svc_name, "cust", "after_recovery", 42, "MINUTE")
    r = api.wait_for_limit(
        lambda: api.check(qe, svc_name, "cust", "after_recovery"), 42, timeout=12
    )
    assert r.limit == 42
