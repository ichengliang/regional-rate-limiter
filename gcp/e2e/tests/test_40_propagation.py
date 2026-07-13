"""A newly created limit reaches the data plane within the new-limit SLA (~5s).

quotaenforcer resolves caps through a read-through cache over quotamgmt's
Postgres; a not-yet-seen key is negative-cached for ~5s, so a brand-new limit
becomes enforceable within that window."""
import time


def test_new_limit_propagates(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)

    # Prime the negative cache: query before the limit exists (=> unlimited).
    assert api.check(qe, svc_name, "cust", "rpm").limit == 0

    api.create_limit(qm, svc_name, "cust", "rpm", 25, "MINUTE")

    start = time.time()
    r = api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 25, timeout=15)
    elapsed = time.time() - start
    assert r.limit == 25
    # Generous ceiling above the ~5s negative-cache TTL (+jitter, +LB latency).
    assert elapsed < 15, f"propagation took {elapsed:.1f}s"
