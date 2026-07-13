"""Enforcer HPA scale-up under load (opt-in; run with `-m slow`).

Drives sustained CheckQuota load through the data-plane LB and asserts the HPA
scales the enforcer above its floor of 3. This is environment-dependent (needs
enough offered load to push CPU past target); it is deselected by default and
paired with `scripts/loadgen.sh` for manual runs."""
import json
import shutil
import subprocess
import threading
import time

import pytest

from conftest import NAMESPACE

pytestmark = pytest.mark.slow


def _current_replicas():
    p = subprocess.run(
        ["kubectl", "-n", NAMESPACE, "get", "hpa", "quotaenforcer", "-o", "json"],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        pytest.skip(f"kubectl/hpa not reachable: {p.stderr.strip()}")
    return json.loads(p.stdout)["status"].get("currentReplicas", 0)


def test_enforcer_scales_up_under_load(qm, qe, api, svc_name):
    if not shutil.which("kubectl"):
        pytest.skip("kubectl not on PATH")

    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "*", "rpm", 1_000_000, "MINUTE")  # effectively unlimited
    api.wait_for_limit(lambda: api.check(qe, svc_name, "0", "rpm"), 1_000_000)

    stop = threading.Event()

    def hammer(worker):
        i = 0
        while not stop.is_set():
            try:
                api.check(qe, svc_name, f"{worker}-{i % 500}", "rpm")
            except Exception:
                pass
            i += 1

    workers = [threading.Thread(target=hammer, args=(w,), daemon=True) for w in range(64)]
    for t in workers:
        t.start()

    try:
        deadline = time.time() + 300  # up to 5 min for the HPA to react
        peak = 3
        while time.time() < deadline:
            peak = max(peak, _current_replicas())
            if peak > 3:
                break
            time.sleep(15)
        assert peak > 3, "enforcer did not scale above 3 under load (offered load may be too low)"
        assert peak <= 10, "enforcer exceeded HPA max of 10"
    finally:
        stop.set()
