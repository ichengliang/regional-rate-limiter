"""Control-plane CRUD through the quotamgmt LB: create -> get(resolve) -> delete."""
import grpc
import pytest

from conftest import _auth


def test_limit_crud_and_resolve(qm, api, svc_name):
    api.register_service(qm, svc_name)

    created = api.create_limit(qm, svc_name, "*", "rpm", 100, "MINUTE")
    assert created.limit.limit_value == 100

    # Exact-then-default resolution: an unconfigured customer resolves to the '*'.
    resolved = api.get_limit(qm, svc_name, "cust_new", "rpm", resolve=True)
    assert resolved.limit.limit_value == 100

    api.delete_limit(qm, svc_name, "*", "rpm")
    with pytest.raises(grpc.RpcError) as e:
        api.get_limit(qm, svc_name, "*", "rpm", resolve=False)
    assert e.value.code() == grpc.StatusCode.NOT_FOUND
