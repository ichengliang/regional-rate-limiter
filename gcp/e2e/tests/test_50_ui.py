"""quotaui admin console (BFF over its HTTP LB): auth, RBAC, config read, live usage.

The BFF dials quotamgmt/quotaenforcer in-cluster, so this exercises the UI tier
end-to-end against the same backends the gRPC tests hit."""
import requests

CSRF = "x-csrf-token"  # session.ts CSRF_HEADER


def _login(ui_url, user):
    s = requests.Session()
    r = s.post(f"{ui_url}/api/auth/login", json={"user": user}, timeout=10)
    assert r.status_code == 200, r.text
    return s, r.json()["csrf_token"]


def test_requires_auth(ui_url):
    r = requests.get(f"{ui_url}/api/limits?service_name=whatever", timeout=10)
    assert r.status_code == 401


def test_operator_reads_config_and_live_usage(qm, api, ui_url, svc_name):
    # Seed a service + limit via the control plane, then read it through the UI.
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "*", "rpm", 100, "MINUTE")

    s, _ = _login(ui_url, "alice")  # operator (global)

    r = s.get(f"{ui_url}/api/limits", params={"service_name": svc_name}, timeout=10)
    assert r.status_code == 200, r.text
    assert any(l["key"]["rate_limit_id"] == "rpm" for l in r.json().get("limits", []))

    r = s.get(
        f"{ui_url}/api/usage",
        params={"service_name": svc_name, "customer_id": "cust", "rate_limit_id": "rpm"},
        timeout=10,
    )
    assert r.status_code == 200, r.text


def test_viewer_cannot_write(ui_url, svc_name):
    s, csrf = _login(ui_url, "vic")  # viewer
    r = s.post(
        f"{ui_url}/api/limits",
        headers={CSRF: csrf},
        json={
            "service_name": svc_name,
            "customer_id": "*",
            "rate_limit_id": "rpm",
            "limit_value": 10,
            "time_unit": "MINUTE",
        },
        timeout=10,
    )
    assert r.status_code == 403, r.text
