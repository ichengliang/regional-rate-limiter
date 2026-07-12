package com.anthropic.quotamgmt;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quotamgmt.auth.AuthInterceptor;
import com.anthropic.quotamgmt.auth.Authorizer;
import com.anthropic.quotamgmt.auth.Principal;
import com.anthropic.quotamgmt.error.AppException;
import com.anthropic.quotamgmt.paging.Page;
import com.anthropic.quotamgmt.service.ProtoMappers;
import com.anthropic.quotamgmt.store.AuditRepository;
import com.anthropic.quotamgmt.store.AuditRow;
import com.anthropic.quotamgmt.store.LimitRepository;
import com.anthropic.quotamgmt.store.LimitRow;
import com.anthropic.quotamgmt.store.ServiceRepository;
import com.anthropic.quotamgmt.store.ServiceRow;
import com.anthropic.quotamgmt.validation.LimitValidator;
import com.anthropic.quotamgmt.v1.AuditEntry;
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
import com.anthropic.quotamgmt.v1.ServiceInfo;
import com.anthropic.quotamgmt.v1.UpdateLimitRequest;
import com.anthropic.quotamgmt.v1.UpdateLimitResponse;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Implements {@code quotamgmt.v1.LimitAdmin} (design/quotamgmt.md §3). Each RPC
 * follows the same shape: read the authenticated {@link Principal} from the gRPC
 * context, <b>validate</b> the request (§3.8), <b>authorize</b> against the
 * principal's per-service grants (§7.2), then delegate to the repositories, whose
 * writes are audited via {@code SET LOCAL app.actor} (§4.4). Typed failures become
 * the gRPC codes of §3.10.
 */
public final class LimitAdminService extends LimitAdminGrpc.LimitAdminImplBase {

    private static final Logger log = LoggerFactory.getLogger(LimitAdminService.class);

    private final LimitRepository limits;
    private final ServiceRepository services;
    private final AuditRepository audit;
    private final Authorizer authorizer;

    public LimitAdminService(LimitRepository limits, ServiceRepository services,
                             AuditRepository audit, Authorizer authorizer) {
        this.limits = limits;
        this.services = services;
        this.audit = audit;
        this.authorizer = authorizer;
    }

    // ---------- limit CRUD ----------

    @Override
    public void createLimit(CreateLimitRequest request, StreamObserver<CreateLimitResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitKey key = request.getKey();
            LimitValidator.validateLimitWrite(key, request.getLimitValue(), request.getTimeUnit());
            authorizer.requireEditor(principal, key.getServiceName());
            LimitRow row = limits.create(principal.name(), key, request.getLimitValue(),
                    ProtoMappers.toTimeUnitLabel(request.getTimeUnit()));
            return CreateLimitResponse.newBuilder().setLimit(ProtoMappers.toLimit(row)).build();
        });
    }

    @Override
    public void updateLimit(UpdateLimitRequest request, StreamObserver<UpdateLimitResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitKey key = request.getKey();
            LimitValidator.validateLimitWrite(key, request.getLimitValue(), request.getTimeUnit());
            authorizer.requireEditor(principal, key.getServiceName());
            LimitRow row = limits.update(principal.name(), key, request.getLimitValue(),
                    ProtoMappers.toTimeUnitLabel(request.getTimeUnit()), request.getCreateIfAbsent());
            return UpdateLimitResponse.newBuilder().setLimit(ProtoMappers.toLimit(row)).build();
        });
    }

    @Override
    public void deleteLimit(DeleteLimitRequest request, StreamObserver<DeleteLimitResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitKey key = request.getKey();
            LimitValidator.validateKey(key);
            authorizer.requireEditor(principal, key.getServiceName());
            limits.delete(principal.name(), key, request.getAllowMissing());
            return DeleteLimitResponse.getDefaultInstance();
        });
    }

    @Override
    public void getLimit(GetLimitRequest request, StreamObserver<GetLimitResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitKey key = request.getKey();
            LimitValidator.validateKey(key);
            authorizer.requireViewer(principal, key.getServiceName());
            LimitRow row = (request.getResolve()
                    ? limits.resolve(key.getServiceName(), key.getCustomerId(), key.getRateLimitId())
                    : limits.getExact(key))
                    .orElseThrow(() -> AppException.of(Status.Code.NOT_FOUND,
                            "no limit for " + tuple(key)
                                    + (request.getResolve() ? " (exact or default)" : "")));
            return GetLimitResponse.newBuilder()
                    .setLimit(ProtoMappers.toLimit(row))
                    .setIsDefault(row.isDefault())
                    .build();
        });
    }

    @Override
    public void listLimits(ListLimitsRequest request, StreamObserver<ListLimitsResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitValidator.validateServiceName(request.getServiceName());
            authorizer.requireViewer(principal, request.getServiceName());
            Page<LimitRow> page = limits.list(
                    request.getServiceName(),
                    request.getCustomerId(),
                    request.getRateLimitId(),
                    LimitValidator.clampPageSize(request.getPageSize()),
                    request.getPageToken());
            ListLimitsResponse.Builder b = ListLimitsResponse.newBuilder()
                    .setNextPageToken(page.nextPageToken());
            page.items().forEach(row -> b.addLimits(ProtoMappers.toLimit(row)));
            return b.build();
        });
    }

    // ---------- service registry ----------

    @Override
    public void registerService(RegisterServiceRequest request, StreamObserver<RegisterServiceResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            authorizer.requirePlatformAdmin(principal);
            ServiceInfo info = request.getService();
            LimitValidator.validateServiceName(info.getServiceName());
            requireNonEmpty("display_name", info.getDisplayName());
            requireNonEmpty("owner", info.getOwner());
            ServiceRow row = services.register(
                    new ServiceRow(info.getServiceName(), info.getDisplayName(), info.getOwner()));
            return RegisterServiceResponse.newBuilder()
                    .setService(ProtoMappers.toServiceInfo(row)).build();
        });
    }

    @Override
    public void getService(GetServiceRequest request, StreamObserver<GetServiceResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitValidator.validateServiceName(request.getServiceName());
            authorizer.requireViewer(principal, request.getServiceName());
            ServiceRow row = services.get(request.getServiceName())
                    .orElseThrow(() -> AppException.of(Status.Code.NOT_FOUND,
                            "service '" + request.getServiceName() + "' is not registered"));
            return GetServiceResponse.newBuilder()
                    .setService(ProtoMappers.toServiceInfo(row)).build();
        });
    }

    @Override
    public void listServices(ListServicesRequest request, StreamObserver<ListServicesResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            Page<ServiceRow> page = services.list(
                    LimitValidator.clampPageSize(request.getPageSize()),
                    request.getPageToken(),
                    principal.viewableServices(),
                    principal.platformAdmin());
            ListServicesResponse.Builder b = ListServicesResponse.newBuilder()
                    .setNextPageToken(page.nextPageToken());
            page.items().forEach(row -> b.addServices(ProtoMappers.toServiceInfo(row)));
            return b.build();
        });
    }

    // ---------- audit ----------

    @Override
    public void listAuditEntries(ListAuditEntriesRequest request, StreamObserver<ListAuditEntriesResponse> obs) {
        handle(obs, () -> {
            Principal principal = AuthInterceptor.currentPrincipal();
            LimitValidator.validateServiceName(request.getServiceName());
            authorizer.requireViewer(principal, request.getServiceName());
            Optional<LimitKey> key = request.hasKey() ? Optional.of(request.getKey()) : Optional.empty();
            Optional<Long> configId = request.getConfigId() != 0
                    ? Optional.of(request.getConfigId()) : Optional.empty();
            Optional<Instant> since = request.hasSince()
                    ? Optional.of(Instant.ofEpochSecond(
                            request.getSince().getSeconds(), request.getSince().getNanos()))
                    : Optional.empty();
            Page<AuditRow> page = audit.list(
                    request.getServiceName(), key, configId, since,
                    LimitValidator.clampPageSize(request.getPageSize()),
                    request.getPageToken());
            ListAuditEntriesResponse.Builder b = ListAuditEntriesResponse.newBuilder()
                    .setNextPageToken(page.nextPageToken());
            page.items().forEach(row -> b.addEntries(ProtoMappers.toAuditEntry(row)));
            return b.build();
        });
    }

    // ---------- helpers ----------

    private <T> void handle(StreamObserver<T> obs, Supplier<T> body) {
        try {
            T response = body.get();
            obs.onNext(response);
            obs.onCompleted();
        } catch (AppException e) {
            obs.onError(e.toStatusRuntimeException());
        } catch (RuntimeException e) {
            log.error("unexpected error handling request", e);
            obs.onError(Status.INTERNAL.withDescription("internal error").asRuntimeException());
        }
    }

    private static void requireNonEmpty(String field, String value) {
        if (value == null || value.isEmpty()) {
            throw AppException.invalidArgument(field, field + " is required");
        }
    }

    private static String tuple(LimitKey key) {
        return "(" + key.getServiceName() + ", " + key.getCustomerId() + ", "
                + key.getRateLimitId() + ")";
    }
}
