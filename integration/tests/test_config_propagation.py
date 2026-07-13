"""Control plane → data plane: config written via quotamgmt is enforced by
quotaenforcer, through Postgres (design/quotaenforcer.md §5, propagation SLA ≤5s).

This is the central cross-component seam: quotamgmt owns config, quotaenforcer is
a read-through consumer of it.
"""

import pytest


def test_new_limit_propagates_within_sla(qm, qe, api, svc_name):
    api.register_service(qm, svc_name)

    # Before any config exists: unconfigured → allow / unlimited (limit 0).
    # (This also negative-caches the miss in quotaenforcer for a few seconds.)
    before = api.check(qe, svc_name, "cust", "rpm")
    assert before.allowed and before.limit == 0

    # Create the limit in the control plane.
    api.create_limit(qm, svc_name, "cust", "rpm", 500, "MINUTE")

    # The data plane must pick it up within the propagation window (negative-cache
    # expiry, ≤ ~10s incl. jitter).
    after = api.wait_for_limit(
        lambda: api.check(qe, svc_name, "cust", "rpm"), expected_limit=500, timeout=12
    )
    assert after.limit == 500 and after.allowed and after.remaining == 500


@pytest.mark.slow
def test_update_of_cached_cap_propagates_within_ttl(qm, qe, api, svc_name):
    """Updating an ALREADY-CACHED cap propagates within quotaenforcer's positive
    cache TTL (~30s + jitter) — the accepted TTL-based freshness behavior, not the
    ≤5s SLA (that would need the deferred change-feed poller). See quotaenforcer
    README "Config propagation & freshness". Marked `slow`; run with `-m slow`.
    """
    api.register_service(qm, svc_name)
    api.create_limit(qm, svc_name, "cust", "rpm", 100, "MINUTE")
    api.wait_for_limit(lambda: api.check(qe, svc_name, "cust", "rpm"), 100, timeout=12)

    # Update the cap; it re-resolves once the positive entry's TTL expires.
    qm.UpdateLimit(
        api.qm_pb2.UpdateLimitRequest(
            key=api.key(svc_name, "cust", "rpm"),
            limit_value=777,
            time_unit=api.UNIT["MINUTE"],
        ),
        metadata=api.auth(),
    )
    # Bounded by config_positive_ttl (30s) + jitter (5s); allow margin.
    updated = api.wait_for_limit(
        lambda: api.check(qe, svc_name, "cust", "rpm"), expected_limit=777, timeout=45
    )
    assert updated.limit == 777
