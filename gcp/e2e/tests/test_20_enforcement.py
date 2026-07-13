"""Full enforcement lifecycle across control + data plane, over the LBs:
create (quotamgmt) -> check / charge / usage / exhaust-deny / refund (quotaenforcer)."""


def test_charge_check_refund_usage_lifecycle(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "cust", "rpm", 10, "MINUTE")

    # Fresh window once the new cap has propagated (~5s SLA).
    r = api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 10)
    assert r.allowed and r.remaining == 10 and r.limit == 10

    assert api.charge(qe, svc_name, "cust", "rpm", cost=4).remaining == 6

    u = api.get_usage(qe, svc_name, "cust", "rpm")
    assert u.configured and u.consumed == 4 and u.remaining == 6 and u.limit == 10

    # Exhaust -> a cost-1 check is denied.
    assert api.charge(qe, svc_name, "cust", "rpm", cost=6).remaining == 0
    denied = api.check(qe, svc_name, "cust", "rpm", cost=1)
    assert not denied.allowed and denied.remaining == 0

    # Refund restores capacity.
    assert api.refund(qe, svc_name, "cust", "rpm", amount=5).remaining == 5
    assert api.check(qe, svc_name, "cust", "rpm", cost=1).allowed


def test_charge_can_overshoot_negative(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "cust", "rpm", 100, "MINUTE")
    api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 100)

    assert api.charge(qe, svc_name, "cust", "rpm", cost=150).remaining == -50
    denied = api.check(qe, svc_name, "cust", "rpm", cost=1)
    assert not denied.allowed and denied.remaining == -50
