"""High-availability posture, verified via kubectl:
- every service runs >= 3 ready replicas,
- the enforcer HPA is configured to scale 3 -> 10.

Marked `ha`; skipped automatically when kubectl can't reach the namespace."""
import json
import shutil
import subprocess

import pytest

from conftest import NAMESPACE

pytestmark = pytest.mark.ha


def _kubectl_json(*args):
    if not shutil.which("kubectl"):
        pytest.skip("kubectl not on PATH")
    p = subprocess.run(
        ["kubectl", "-n", NAMESPACE, *args, "-o", "json"],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        pytest.skip(f"kubectl failed (cluster not reachable?): {p.stderr.strip()}")
    return json.loads(p.stdout)


@pytest.mark.parametrize("deploy", ["quotamgmt", "quotaenforcer", "quotaui"])
def test_at_least_three_ready_replicas(deploy):
    d = _kubectl_json("get", "deploy", deploy)
    ready = d["status"].get("readyReplicas", 0)
    assert ready >= 3, f"{deploy} has {ready} ready replicas (want >= 3)"


def test_enforcer_hpa_3_to_10():
    h = _kubectl_json("get", "hpa", "quotaenforcer")
    spec = h["spec"]
    assert spec["minReplicas"] == 3 and spec["maxReplicas"] == 10
