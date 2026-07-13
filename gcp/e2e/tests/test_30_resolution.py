"""'*'-default vs exact-customer override, and unconfigured => allow/unlimited."""


def test_exact_overrides_default(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "*", "rpm", 50, "MINUTE")       # default
    api.create_limit(qm, svc_name, "vip", "rpm", 5, "MINUTE")      # exact override

    # The exact customer gets the smaller cap...
    vip = api.wait_for_limit(lambda: api.check(qe, svc_name, "vip", "rpm"), 5)
    assert vip.limit == 5
    # ...an unlisted customer falls back to the '*' default.
    other = api.wait_for_limit(lambda: api.check(qe, svc_name, "someone-else", "rpm"), 50)
    assert other.limit == 50


def test_unconfigured_is_allowed(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    # No limit configured for this rate_limit_id => unlimited/allow.
    r = api.check(qe, svc_name, "cust", "unconfigured-rlid")
    assert r.allowed is True
    u = api.get_usage(qe, svc_name, "cust", "unconfigured-rlid")
    assert u.configured is False
