"""Cap resolution across the seam: the '*' default vs an exact customer row, and
unconfigured → allow (design §5.1-5.3). Config authored in quotamgmt, observed
through quotaenforcer.
"""


def test_star_default_applies_then_exact_overrides(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)

    # Only a '*' default exists → an unlisted customer rides it.
    api.create_limit(qm, svc_name, "*", "rpm", 50, "MINUTE")
    d = api.wait_for_limit(lambda: api.check(qe, svc_name, "unlisted", "rpm"), 50, timeout=12)
    assert d.limit == 50

    # An exact row wins over the default for that customer.
    api.create_limit(qm, svc_name, "vip", "rpm", 9000, "MINUTE")
    v = api.wait_for_limit(lambda: api.check(qe, svc_name, "vip", "rpm"), 9000, timeout=12)
    assert v.limit == 9000

    # The default still applies to everyone else.
    assert api.check(qe, svc_name, "someone_else", "rpm").limit == 50


def test_unconfigured_allows_unlimited(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)
    # No exact row, no '*' default → allow, limit 0 (unlimited).
    r = api.check(qe, svc_name, "cust", "never_configured")
    assert r.allowed and r.limit == 0

    u = api.get_usage(qe, svc_name, "cust", "never_configured")
    assert not u.configured
