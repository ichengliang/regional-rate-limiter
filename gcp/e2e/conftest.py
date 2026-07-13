"""E2E harness targeting the DEPLOYED GKE stack (external LoadBalancers).

Unlike the in-repo `integration/` suite (which boots services via docker-compose),
this suite points at the live endpoints and drives them exactly as a real client
would. Endpoints and the admin token come from the environment:

    QUOTAMGMT_ADDR      host:port of the quotamgmt gRPC LB      (e.g. 34.1.2.3:8443)
    QUOTAENFORCER_ADDR  host:port of the quotaenforcer gRPC LB  (e.g. 34.1.2.4:8444)
    QUOTAUI_URL         base URL of the quotaui HTTP LB         (e.g. http://34.1.2.5)
    QUOTAMGMT_TOKEN     dev platform-admin bearer token         (default matches deploy)
    NAMESPACE           k8s namespace for the `ha`-marked tests (default: quota)

A suite whose endpoint env var is unset is skipped, so you can run a subset
(e.g. only the UI tests) without standing up everything.
"""

from __future__ import annotations

import os
import pathlib
import sys
import time

import grpc
import pytest

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE / "gen"))

import quota.common.v1.common_pb2 as common_pb2  # noqa: E402
import quotamgmt.v1.limit_admin_pb2 as qm_pb2  # noqa: E402
import quotamgmt.v1.limit_admin_pb2_grpc as qm_grpc  # noqa: E402
import quotaenforcer.v1.rate_limiter_pb2 as qe_pb2  # noqa: E402
import quotaenforcer.v1.rate_limiter_pb2_grpc as qe_grpc  # noqa: E402

TOKEN = os.environ.get("QUOTAMGMT_TOKEN", "quota-demo-admin-token")
NAMESPACE = os.environ.get("NAMESPACE", "quota")
UNIT = {"MINUTE": common_pb2.MINUTE, "DAY": common_pb2.DAY, "MONTH": common_pb2.MONTH}

# A per-run suffix keeps keys unique across reruns (avoids stale windows/negative
# cache from a previous run interfering).
RUN_ID = f"{int(time.time())}-{os.getpid()}"


def _auth():
    return (("authorization", f"Bearer {TOKEN}"),)


def _ready_channel(addr: str, name: str):
    ch = grpc.insecure_channel(addr)
    try:
        grpc.channel_ready_future(ch).result(timeout=20)
    except grpc.FutureTimeoutError:
        pytest.fail(f"{name} not reachable at {addr} within 20s")
    return ch


# ---------------- endpoint fixtures (skip if not configured) ----------------
@pytest.fixture(scope="session")
def qm():
    addr = os.environ.get("QUOTAMGMT_ADDR")
    if not addr:
        pytest.skip("QUOTAMGMT_ADDR not set")
    return qm_grpc.LimitAdminStub(_ready_channel(addr, "quotamgmt"))


@pytest.fixture(scope="session")
def qe():
    addr = os.environ.get("QUOTAENFORCER_ADDR")
    if not addr:
        pytest.skip("QUOTAENFORCER_ADDR not set")
    return qe_grpc.RateLimiterStub(_ready_channel(addr, "quotaenforcer"))


@pytest.fixture(scope="session")
def ui_url():
    url = os.environ.get("QUOTAUI_URL")
    if not url:
        pytest.skip("QUOTAUI_URL not set")
    return url.rstrip("/")


# ---------------- client helpers (mirror the integration harness) ----------------
class Api:
    @staticmethod
    def key(svc, cust, rlid):
        return common_pb2.LimitKey(service_name=svc, customer_id=cust, rate_limit_id=rlid)

    def register_service(self, qm, name):
        qm.RegisterService(
            qm_pb2.RegisterServiceRequest(
                service=qm_pb2.ServiceInfo(service_name=name, display_name=name, owner="e2e")
            ),
            metadata=_auth(),
        )

    def create_limit(self, qm, svc, cust, rlid, value, unit):
        return qm.CreateLimit(
            qm_pb2.CreateLimitRequest(key=self.key(svc, cust, rlid), limit_value=value, time_unit=UNIT[unit]),
            metadata=_auth(),
        )

    def delete_limit(self, qm, svc, cust, rlid, allow_missing=True):
        return qm.DeleteLimit(
            qm_pb2.DeleteLimitRequest(key=self.key(svc, cust, rlid), allow_missing=allow_missing),
            metadata=_auth(),
        )

    def get_limit(self, qm, svc, cust, rlid, resolve=False):
        return qm.GetLimit(
            qm_pb2.GetLimitRequest(key=self.key(svc, cust, rlid), resolve=resolve), metadata=_auth()
        )

    def check(self, qe, svc, cust, rlid, cost=1):
        return qe.CheckQuota(qe_pb2.CheckQuotaRequest(key=self.key(svc, cust, rlid), cost=cost))

    def charge(self, qe, svc, cust, rlid, cost=1, request_id=""):
        return qe.Charge(qe_pb2.ChargeRequest(key=self.key(svc, cust, rlid), cost=cost, request_id=request_id))

    def refund(self, qe, svc, cust, rlid, amount, request_id=""):
        return qe.Refund(qe_pb2.RefundRequest(key=self.key(svc, cust, rlid), amount=amount, request_id=request_id))

    def get_usage(self, qe, svc, cust, rlid):
        return qe.GetUsage(qe_pb2.GetUsageRequest(key=self.key(svc, cust, rlid)))

    @staticmethod
    def wait_for_limit(check_fn, expected_limit, timeout=15.0):
        """Poll a CheckQuota closure until `limit` == expected (new-limit SLA ~5s)."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = check_fn()
            if last.limit == expected_limit:
                return last
            time.sleep(0.5)
        raise AssertionError(f"limit did not become {expected_limit} within {timeout}s (last={last})")


@pytest.fixture(scope="session")
def api():
    return Api()


@pytest.fixture()
def svc_name(request):
    """A unique, registered service per test (isolates windows/config)."""
    return f"e2e-{request.node.name[:20]}-{RUN_ID}".replace("_", "-")
