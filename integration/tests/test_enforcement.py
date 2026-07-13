"""End-to-end enforcement lifecycle across control + data planes:
create a limit (quotamgmt) → check / charge / refund / usage (quotaenforcer),
including the intentional negative-overshoot behavior (design §3, §6.4).
"""


def test_charge_check_refund_usage_lifecycle(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "cust", "rpm", 10, "MINUTE")

    # Fresh window: full quota once the cap has propagated.
    r = api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 10, timeout=12)
    assert r.allowed and r.remaining == 10 and r.limit == 10

    # Charge 4 → remaining 6.
    assert api.charge(qe, svc_name, "cust", "rpm", cost=4).remaining == 6

    # Live usage reflects consumed=4.
    u = api.get_usage(qe, svc_name, "cust", "rpm")
    assert u.configured and u.consumed == 4 and u.remaining == 6 and u.limit == 10

    # Charge 6 more → remaining 0; a cost-1 check is now denied.
    assert api.charge(qe, svc_name, "cust", "rpm", cost=6).remaining == 0
    denied = api.check(qe, svc_name, "cust", "rpm", cost=1)
    assert not denied.allowed and denied.remaining == 0

    # Refund 5 → remaining 5, allowed again.
    assert api.refund(qe, svc_name, "cust", "rpm", amount=5).remaining == 5
    assert api.check(qe, svc_name, "cust", "rpm", cost=1).allowed


def test_charge_can_overshoot_negative(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "cust", "rpm", 100, "MINUTE")
    api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 100, timeout=12)

    # A single charge beyond the cap drives remaining negative (by design).
    assert api.charge(qe, svc_name, "cust", "rpm", cost=150).remaining == -50
    denied = api.check(qe, svc_name, "cust", "rpm", cost=1)
    assert not denied.allowed and denied.remaining == -50
