"""Pytest harness for the cross-component integration tests.

Brings up (or reuses) the compose infra, builds + starts the two gRPC services
(quotamgmt control plane, quotaenforcer data plane) pointed at that infra, and
exposes ready-to-use gRPC stubs. The quotaui BFF tier is added in test_ui.py's
own fixtures (Stage B).

Everything is session-scoped so the services boot once per `pytest` run.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import time

import grpc
import pytest

HERE = pathlib.Path(__file__).parent
REPO = HERE.parent
sys.path.insert(0, str(HERE / "gen"))

import quota.common.v1.common_pb2 as common_pb2  # noqa: E402
import quotamgmt.v1.limit_admin_pb2 as qm_pb2  # noqa: E402
import quotamgmt.v1.limit_admin_pb2_grpc as qm_grpc  # noqa: E402
import quotaenforcer.v1.rate_limiter_pb2 as qe_pb2  # noqa: E402
import quotaenforcer.v1.rate_limiter_pb2_grpc as qe_grpc  # noqa: E402

# ---- fixed topology (isolated ports; see docker-compose.yml) ----
PG_HOST, PG_PORT = "127.0.0.1", 55432
REDIS_PORT = 56379
QM_PORT = 18443  # quotamgmt gRPC
QE_PORT = 18444  # quotaenforcer gRPC
BFF_PORT = 18080  # quotaui BFF HTTP
DEV_TOKEN = "integration-admin-token"

PG_ENV = {
    "PGHOST": PG_HOST,
    "PGPORT": str(PG_PORT),
    "PGUSER": "postgres",
    "PGPASSWORD": "postgres",
    "PGDATABASE": "quota",
}
LOGS = HERE / ".logs"


def _auth():
    """Bearer metadata for quotamgmt (dev platform-admin token)."""
    return (("authorization", f"Bearer {DEV_TOKEN}"),)


# --------------------------------------------------------------------------
# infra
# --------------------------------------------------------------------------
@pytest.fixture(scope="session")
def infra():
    """Ensure the Postgres + Redis compose stack is up and healthy."""
    subprocess.run(
        ["docker", "compose", "up", "-d"], cwd=HERE, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    _await_compose_healthy(("postgres", "redis"), timeout=90)
    yield
    if os.environ.get("KEEP_INFRA") != "1":
        subprocess.run(
            ["docker", "compose", "down", "-v"], cwd=HERE,
            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        )


def _await_compose_healthy(services, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        out = subprocess.run(
            ["docker", "compose", "ps", "--format", "{{.Service}}:{{.Health}}"],
            cwd=HERE, capture_output=True, text=True,
        ).stdout
        health = dict(
            line.split(":", 1) for line in out.strip().splitlines() if ":" in line
        )
        if all(health.get(s) == "healthy" for s in services):
            return
        time.sleep(1)
    raise RuntimeError(f"infra not healthy within {timeout}s: {out!r}")


# --------------------------------------------------------------------------
# services
# --------------------------------------------------------------------------
@pytest.fixture(scope="session")
def services(infra):
    """Build (if needed) and start quotamgmt + quotaenforcer against the infra."""
    LOGS.mkdir(exist_ok=True)
    procs = []
    try:
        procs.append(_start_quotamgmt())
        procs.append(_start_quotaenforcer())
        _await_grpc_ready()
        yield {"quotamgmt": f"127.0.0.1:{QM_PORT}", "quotaenforcer": f"127.0.0.1:{QE_PORT}"}
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()


def _start_quotamgmt():
    bin_path = REPO / "quotamgmt/build/install/quotamgmt/bin/quotamgmt"
    if not bin_path.exists():
        subprocess.run(
            ["./gradlew", "installDist", "-q"], cwd=REPO / "quotamgmt", check=True
        )
    env = {
        **os.environ,
        **PG_ENV,
        "QUOTAMGMT_PORT": str(QM_PORT),
        # gradle 'application' start script forwards <APP>_OPTS as JVM args.
        "QUOTAMGMT_OPTS": f"-Dquotamgmt.auth.devAdminToken={DEV_TOKEN}",
    }
    log = open(LOGS / "quotamgmt.log", "w")
    return subprocess.Popen([str(bin_path)], env=env, stdout=log, stderr=subprocess.STDOUT)


def _start_quotaenforcer():
    bin_path = REPO / "quotaenforcer/target/debug/quotaenforcer"
    if not bin_path.exists():
        subprocess.run(["cargo", "build"], cwd=REPO / "quotaenforcer", check=True)
    env = {
        **os.environ,
        **PG_ENV,
        "REDIS_URL": f"redis://127.0.0.1:{REDIS_PORT}",
        "QUOTAENFORCER_ADDR": f"127.0.0.1:{QE_PORT}",
    }
    log = open(LOGS / "quotaenforcer.log", "w")
    return subprocess.Popen([str(bin_path)], env=env, stdout=log, stderr=subprocess.STDOUT)


def _await_grpc_ready(timeout=60):
    """Poll both services with a real RPC until they answer."""
    deadline = time.time() + timeout
    qm = qm_grpc.LimitAdminStub(grpc.insecure_channel(f"127.0.0.1:{QM_PORT}"))
    qe = qe_grpc.RateLimiterStub(grpc.insecure_channel(f"127.0.0.1:{QE_PORT}"))
    last = None
    while time.time() < deadline:
        try:
            qm.ListServices(qm_pb2.ListServicesRequest(page_size=1), metadata=_auth(), timeout=3)
            qe.CheckQuota(
                qe_pb2.CheckQuotaRequest(
                    key=common_pb2.LimitKey(
                        service_name="__ready__", customer_id="c", rate_limit_id="r"
                    ),
                    cost=1,
                ),
                timeout=3,
            )
            return
        except grpc.RpcError as e:  # not up yet
            last = e
            time.sleep(1)
    raise RuntimeError(f"services not ready within {timeout}s; last error: {last}")


# --------------------------------------------------------------------------
# clients + helpers
# --------------------------------------------------------------------------
@pytest.fixture(scope="session")
def qm(services):
    return qm_grpc.LimitAdminStub(grpc.insecure_channel(services["quotamgmt"]))


@pytest.fixture(scope="session")
def qe(services):
    return qe_grpc.RateLimiterStub(grpc.insecure_channel(services["quotaenforcer"]))


@pytest.fixture(scope="session")
def bff(services):
    """Build (if needed) and start the quotaui BFF against the two backends.

    Passes QUOTAMGMT_TOKEN so the BFF authenticates to quotamgmt (the bearer-token
    fix in quotaui/bff/src/grpc.ts). Yields the base URL.
    """
    bff_dir = REPO / "quotaui/bff"
    if not (bff_dir / "dist/index.js").exists():
        subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=bff_dir, check=True)
        subprocess.run(["npm", "run", "build"], cwd=bff_dir, check=True)
    env = {
        **os.environ,
        "PORT": str(BFF_PORT),
        "QUOTAMGMT_ADDR": f"127.0.0.1:{QM_PORT}",
        "QUOTAENFORCER_ADDR": f"127.0.0.1:{QE_PORT}",
        "QUOTAMGMT_TOKEN": DEV_TOKEN,
        "AUTH_MODE": "dev",
        "PROTO_ROOT": str(REPO / "proto"),
    }
    log = open(LOGS / "bff.log", "w")
    proc = subprocess.Popen(["node", "dist/index.js"], cwd=bff_dir, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        _await_http(f"http://127.0.0.1:{BFF_PORT}/healthz", timeout=40)
        yield f"http://127.0.0.1:{BFF_PORT}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _await_http(url, timeout):
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(1)
    raise RuntimeError(f"{url} not ready within {timeout}s")


@pytest.fixture
def api():
    """Small facade bundling protos, the auth helper, and CRUD/enforce shortcuts."""
    return _Api()


class _Api:
    common = common_pb2
    qm_pb2 = qm_pb2
    qe_pb2 = qe_pb2
    auth = staticmethod(_auth)

    UNIT = {
        "MINUTE": common_pb2.MINUTE,
        "DAY": common_pb2.DAY,
        "MONTH": common_pb2.MONTH,
    }

    @staticmethod
    def key(svc, cust, rlid):
        return common_pb2.LimitKey(service_name=svc, customer_id=cust, rate_limit_id=rlid)

    def register_service(self, qm, name):
        qm.RegisterService(
            qm_pb2.RegisterServiceRequest(
                service=qm_pb2.ServiceInfo(service_name=name, display_name=name, owner="it")
            ),
            metadata=_auth(),
        )

    def create_limit(self, qm, svc, cust, rlid, value, unit):
        return qm.CreateLimit(
            qm_pb2.CreateLimitRequest(
                key=self.key(svc, cust, rlid), limit_value=value, time_unit=self.UNIT[unit]
            ),
            metadata=_auth(),
        )

    def delete_limit(self, qm, svc, cust, rlid, allow_missing=True):
        return qm.DeleteLimit(
            qm_pb2.DeleteLimitRequest(key=self.key(svc, cust, rlid), allow_missing=allow_missing),
            metadata=_auth(),
        )

    def check(self, qe, svc, cust, rlid, cost=1):
        return qe.CheckQuota(qe_pb2.CheckQuotaRequest(key=self.key(svc, cust, rlid), cost=cost))

    def charge(self, qe, svc, cust, rlid, cost=1, request_id=""):
        return qe.Charge(
            qe_pb2.ChargeRequest(key=self.key(svc, cust, rlid), cost=cost, request_id=request_id)
        )

    def refund(self, qe, svc, cust, rlid, amount, request_id=""):
        return qe.Refund(
            qe_pb2.RefundRequest(key=self.key(svc, cust, rlid), amount=amount, request_id=request_id)
        )

    def get_usage(self, qe, svc, cust, rlid):
        return qe.GetUsage(qe_pb2.GetUsageRequest(key=self.key(svc, cust, rlid)))

    @staticmethod
    def wait_for_limit(qe_check_fn, expected_limit, timeout=8.0):
        """Poll a CheckQuota closure until `limit` == expected (propagation SLA ≤5s)."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = qe_check_fn()
            if last.limit == expected_limit:
                return last
            time.sleep(0.5)
        raise AssertionError(f"limit did not become {expected_limit} within {timeout}s; last={last}")


@pytest.fixture
def svc_name():
    """A unique service name matching quotamgmt's ^[a-z0-9][a-z0-9-]{0,62}$ rule."""
    import uuid

    return f"it-{uuid.uuid4().hex[:12]}"
