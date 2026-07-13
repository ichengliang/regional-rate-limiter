"""Reachability: all three externally-exposed services answer over their LBs."""
import requests

from conftest import qm_pb2, _auth


def test_quotamgmt_reachable(qm):
    # A trivial authed RPC proves the control-plane LB routes to a live pod.
    qm.ListServices(qm_pb2.ListServicesRequest(page_size=1), metadata=_auth())


def test_quotaenforcer_reachable_and_failopen_default(qe, api):
    # Unconfigured key => allowed/unlimited (fail-open default). Proves the
    # data-plane LB reaches a pod that can talk to Redis + config.
    r = api.check(qe, "no-such-svc", "no-such-cust", "no-such-rlid")
    assert r.allowed is True


def test_quotaui_healthz(ui_url):
    r = requests.get(f"{ui_url}/healthz", timeout=10)
    assert r.status_code == 200 and r.json().get("status") == "ok"


def test_quotaui_serves_spa(ui_url):
    # The BFF serves the built SPA at "/" (single-container quotaui).
    r = requests.get(f"{ui_url}/", timeout=10)
    assert r.status_code == 200 and "<div id=\"root\"" in r.text or "<html" in r.text.lower()
