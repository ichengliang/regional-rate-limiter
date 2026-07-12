package com.anthropic.quotamgmt;

import com.anthropic.quotamgmt.v1.CreateLimitRequest;
import com.anthropic.quotamgmt.v1.CreateLimitResponse;
import com.anthropic.quotamgmt.v1.DeleteLimitRequest;
import com.anthropic.quotamgmt.v1.DeleteLimitResponse;
import com.anthropic.quotamgmt.v1.GetLimitRequest;
import com.anthropic.quotamgmt.v1.GetLimitResponse;
import com.anthropic.quotamgmt.v1.GetServiceRequest;
import com.anthropic.quotamgmt.v1.GetServiceResponse;
import com.anthropic.quotamgmt.v1.LimitAdminGrpc;
import com.anthropic.quotamgmt.v1.ListAuditEntriesRequest;
import com.anthropic.quotamgmt.v1.ListAuditEntriesResponse;
import com.anthropic.quotamgmt.v1.ListLimitsRequest;
import com.anthropic.quotamgmt.v1.ListLimitsResponse;
import com.anthropic.quotamgmt.v1.ListServicesRequest;
import com.anthropic.quotamgmt.v1.ListServicesResponse;
import com.anthropic.quotamgmt.v1.RegisterServiceRequest;
import com.anthropic.quotamgmt.v1.RegisterServiceResponse;
import com.anthropic.quotamgmt.v1.UpdateLimitRequest;
import com.anthropic.quotamgmt.v1.UpdateLimitResponse;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;

/**
 * Implements the {@code quotamgmt.v1.LimitAdmin} gRPC service.
 *
 * <p>Scaffold only: every RPC returns UNIMPLEMENTED. The real behavior — Postgres
 * CRUD, audited writes ({@code SET LOCAL app.actor}), validation, authZ/tenant
 * scoping, and the config change-feed — is specified in design/quotamgmt.md (§3–§7)
 * and is TODO.
 */
public final class LimitAdminService extends LimitAdminGrpc.LimitAdminImplBase {

    private static <T> void unimplemented(StreamObserver<T> responseObserver) {
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("not implemented; see design/quotamgmt.md")
                .asRuntimeException());
    }

    @Override
    public void createLimit(CreateLimitRequest request, StreamObserver<CreateLimitResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void updateLimit(UpdateLimitRequest request, StreamObserver<UpdateLimitResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void deleteLimit(DeleteLimitRequest request, StreamObserver<DeleteLimitResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void getLimit(GetLimitRequest request, StreamObserver<GetLimitResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void listLimits(ListLimitsRequest request, StreamObserver<ListLimitsResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void registerService(RegisterServiceRequest request, StreamObserver<RegisterServiceResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void getService(GetServiceRequest request, StreamObserver<GetServiceResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void listServices(ListServicesRequest request, StreamObserver<ListServicesResponse> responseObserver) {
        unimplemented(responseObserver);
    }

    @Override
    public void listAuditEntries(ListAuditEntriesRequest request, StreamObserver<ListAuditEntriesResponse> responseObserver) {
        unimplemented(responseObserver);
    }
}
