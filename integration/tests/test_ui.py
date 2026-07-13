"""Stage B — quotaui BFF tier. Drives the BFF's HTTP API end-to-end:
BFF → quotamgmt (config CRUD, requires the bearer-token fix in grpc.ts) and
BFF → quotaenforcer (live usage). Also checks the BFF's RBAC gate.

Login is the dev flow (POST /api/auth/login {user}); mutations carry the
per-session CSRF token; requests.Session keeps the session cookie.
"""

import requests


def _login(base, user="admin"):
    s = requests.Session()
    r = s.post(f"{base}/api/auth/login", json={"user": user})
    r.raise_for_status()
    s.headers["x-csrf-token"] = r.json()["csrf_token"]
    return s


def test_bff_config_crud_and_live_usage(bff, qe, api, svc_name):
    s = _login(bff, "admin")

    # Register the service through the BFF (BFF → quotamgmt, needs the token).
    r = s.post(
        f"{bff}/api/services",
        json={"service_name": svc_name, "display_name": svc_name, "owner": "it"},
    )
    assert r.status_code in (200, 201), r.text

    # Create a limit through the BFF (this is the write path that previously
    # failed with UNAUTHENTICATED before the bearer-token fix).
    r = s.post(
        f"{bff}/api/limits",
        json={
            "service_name": svc_name,
            "customer_id": "cust",
            "rate_limit_id": "rpm",
            "limit_value": 200,
            "time_unit": "MINUTE",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["limit_value"] == 200

    # Read it back through the BFF (BFF → quotamgmt ListLimits).
    r = s.get(f"{bff}/api/limits", params={"service_name": svc_name})
    assert r.status_code == 200, r.text
    limits = r.json()["limits"]
    assert any(l["rate_limit_id"] == "rpm" and l["limit_value"] == 200 for l in limits)

    # Consume against the data plane, then read live usage through the BFF
    # (BFF → quotaenforcer GetUsage).
    api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 200, timeout=12)
    api.charge(qe, svc_name, "cust", "rpm", cost=30)

    r = s.get(
        f"{bff}/api/usage",
        params={"service_name": svc_name, "customer_id": "cust", "rate_limit_id": "rpm"},
    )
    assert r.status_code == 200, r.text
    u = r.json()
    assert u["configured"] and u["limit"] == 200
    assert u["consumed"] == 30 and u["remaining"] == 170


def test_bff_rbac_viewer_cannot_write(bff, svc_name):
    # 'vic' is a viewer — reads allowed, writes denied by the BFF's own RBAC
    # (before the request ever reaches quotamgmt).
    s = _login(bff, "vic")
    r = s.post(
        f"{bff}/api/services",
        json={"service_name": svc_name, "display_name": svc_name, "owner": "it"},
    )
    assert r.status_code == 403, r.text


def test_bff_requires_auth(bff):
    # No session → 401 on a protected route.
    r = requests.get(f"{bff}/api/limits", params={"service_name": "whatever"})
    assert r.status_code == 401
