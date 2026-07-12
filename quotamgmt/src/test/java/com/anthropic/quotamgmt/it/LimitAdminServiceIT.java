package com.anthropic.quotamgmt.it;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quota.common.v1.TimeUnit;
import com.anthropic.quotamgmt.LimitAdminService;
import com.anthropic.quotamgmt.auth.AuthInterceptor;
import com.anthropic.quotamgmt.auth.InMemoryAuthorizer;
import com.anthropic.quotamgmt.auth.Principal;
import com.anthropic.quotamgmt.error.AppException;
import com.anthropic.quotamgmt.store.AuditRepository;
import com.anthropic.quotamgmt.store.LimitRepository;
import com.anthropic.quotamgmt.store.ServiceRepository;
import com.anthropic.quotamgmt.v1.AuditEntry;
import com.anthropic.quotamgmt.v1.CreateLimitRequest;
import com.anthropic.quotamgmt.v1.CreateLimitResponse;
import com.anthropic.quotamgmt.v1.DeleteLimitRequest;
import com.anthropic.quotamgmt.v1.GetLimitRequest;
import com.anthropic.quotamgmt.v1.GetLimitResponse;
import com.anthropic.quotamgmt.v1.LimitAdminGrpc;
import com.anthropic.quotamgmt.v1.ListAuditEntriesRequest;
import com.anthropic.quotamgmt.v1.ListLimitsResponse;
import com.anthropic.quotamgmt.v1.ListLimitsRequest;
import com.anthropic.quotamgmt.v1.RegisterServiceRequest;
import com.anthropic.quotamgmt.v1.ServiceInfo;
import com.anthropic.quotamgmt.v1.UpdateLimitRequest;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.ServerInterceptors;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.MetadataUtils;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * End-to-end gRPC integration tests: an in-process server with the real auth
 * interceptor and Postgres-backed repositories, exercised through a blocking
 * stub. Follows the worked scenario in design/quotamgmt.md §3.11 and the error /
 * RBAC matrix of §3.10, §7 (§11.1 "API contract tests" and "AuthZ tests").
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class LimitAdminServiceIT {

    private static final Metadata.Key<String> AUTHZ =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
    private static final String SVC = "search-svc";

    private final QuotaMgmtTestDb db = new QuotaMgmtTestDb();
    private Server server;
    private ManagedChannel channel;
    private ServiceRepository services;
    private LimitRepository limits;

    // tokens -> principals
    private static final String T_ADMIN = "admin-tok";
    private static final String T_EDITOR = "editor-tok";   // alice@corp, editor of search-svc
    private static final String T_VIEWER = "viewer-tok";   // bob@corp, viewer of search-svc
    private static final String T_BILLING = "billing-tok"; // billing-team, editor of billing-svc only

    @BeforeAll
    void setUp() throws Exception {
        Assumptions.assumeTrue(db.reachable(), "Postgres not reachable; skipping integration tests");
        db.setUp();
        limits = new LimitRepository(db.dataSource());
        services = new ServiceRepository(db.dataSource());
        AuditRepository audit = new AuditRepository(db.dataSource());

        InMemoryAuthorizer authorizer = new InMemoryAuthorizer()
                .put(T_ADMIN, new Principal("ops@corp", Set.of(), Set.of(), true))
                .put(T_EDITOR, new Principal("alice@corp", Set.of(SVC), Set.of(), false))
                .put(T_VIEWER, new Principal("bob@corp", Set.of(), Set.of(SVC), false))
                .put(T_BILLING, new Principal("billing-team", Set.of("billing-svc"), Set.of(), false));

        LimitAdminService service = new LimitAdminService(limits, services, audit, authorizer);
        String name = "quotamgmt-it-" + System.nanoTime();
        server = InProcessServerBuilder.forName(name).directExecutor()
                .addService(ServerInterceptors.intercept(service, new AuthInterceptor(authorizer)))
                .build().start();
        channel = InProcessChannelBuilder.forName(name).directExecutor().build();
    }

    @AfterAll
    void tearDown() {
        if (channel != null) {
            channel.shutdownNow();
        }
        if (server != null) {
            server.shutdownNow();
        }
        db.tearDown();
    }

    @BeforeEach
    void reset() {
        db.truncate();
    }

    // ---------- stub helpers ----------

    private LimitAdminGrpc.LimitAdminBlockingStub as(String token) {
        Metadata md = new Metadata();
        md.put(AUTHZ, "Bearer " + token);
        return LimitAdminGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(md));
    }

    private LimitAdminGrpc.LimitAdminBlockingStub anonymous() {
        return LimitAdminGrpc.newBlockingStub(channel);
    }

    private static LimitKey key(String cust, String rlid) {
        return LimitKey.newBuilder().setServiceName(SVC).setCustomerId(cust).setRateLimitId(rlid).build();
    }

    private void registerSearchSvc() {
        as(T_ADMIN).registerService(RegisterServiceRequest.newBuilder()
                .setService(ServiceInfo.newBuilder()
                        .setServiceName(SVC).setDisplayName("Search Service").setOwner("search-team"))
                .build());
    }

    private CreateLimitResponse create(String token, String cust, long value) {
        return as(token).createLimit(CreateLimitRequest.newBuilder()
                .setKey(key(cust, "requests_per_min")).setLimitValue(value).setTimeUnit(TimeUnit.MINUTE)
                .build());
    }

    private static Status.Code codeOf(Executable e) {
        StatusRuntimeException ex = assertThrows(StatusRuntimeException.class, e::run);
        return ex.getStatus().getCode();
    }

    @FunctionalInterface
    private interface Executable {
        void run();
    }

    // ---------- tests ----------

    @Test
    void registerServiceRequiresPlatformAdmin() {
        assertEquals(Status.Code.PERMISSION_DENIED, codeOf(() ->
                as(T_EDITOR).registerService(RegisterServiceRequest.newBuilder()
                        .setService(ServiceInfo.newBuilder().setServiceName(SVC)
                                .setDisplayName("x").setOwner("y")).build())));
        // admin succeeds
        registerSearchSvc();
        assertEquals(SVC, as(T_VIEWER).getService(
                com.anthropic.quotamgmt.v1.GetServiceRequest.newBuilder().setServiceName(SVC).build())
                .getService().getServiceName());
    }

    @Test
    void createDefaultThenOverrideAssignsConfigIds() {
        registerSearchSvc();
        CreateLimitResponse def = create(T_EDITOR, "*", 1000);
        assertTrue(def.getLimit().getConfigId() > 0);
        assertEquals(1000, def.getLimit().getLimitValue());

        CreateLimitResponse override = create(T_EDITOR, "cust_42", 5000);
        assertEquals(5000, override.getLimit().getLimitValue());
    }

    @Test
    void duplicateCreateIsAlreadyExists() {
        registerSearchSvc();
        create(T_EDITOR, "cust_42", 5000);
        assertEquals(Status.Code.ALREADY_EXISTS, codeOf(() -> create(T_EDITOR, "cust_42", 6000)));
    }

    @Test
    void createForUnregisteredServiceIsFailedPrecondition() {
        assertEquals(Status.Code.FAILED_PRECONDITION, codeOf(() -> create(T_EDITOR, "cust_42", 5000)));
    }

    @Test
    void upsertRaisesViaUpdateCreateIfAbsent() {
        registerSearchSvc();
        create(T_EDITOR, "cust_42", 5000);
        var resp = as(T_EDITOR).updateLimit(UpdateLimitRequest.newBuilder()
                .setKey(key("cust_42", "requests_per_min")).setLimitValue(6000)
                .setTimeUnit(TimeUnit.MINUTE).setCreateIfAbsent(true).build());
        assertEquals(6000, resp.getLimit().getLimitValue());
    }

    @Test
    void getResolveReturnsDefaultForUnconfiguredCustomer() {
        registerSearchSvc();
        create(T_EDITOR, "*", 1000);
        GetLimitResponse resp = as(T_VIEWER).getLimit(GetLimitRequest.newBuilder()
                .setKey(key("cust_99", "requests_per_min")).setResolve(true).build());
        assertTrue(resp.getIsDefault());
        assertEquals("*", resp.getLimit().getKey().getCustomerId());
        assertEquals(1000, resp.getLimit().getLimitValue());
    }

    @Test
    void getExactMissingIsNotFound() {
        registerSearchSvc();
        assertEquals(Status.Code.NOT_FOUND, codeOf(() -> as(T_VIEWER).getLimit(
                GetLimitRequest.newBuilder().setKey(key("nobody", "requests_per_min")).build())));
    }

    @Test
    void listLimitsReturnsServiceRows() {
        registerSearchSvc();
        create(T_EDITOR, "*", 1000);
        create(T_EDITOR, "cust_42", 5000);
        ListLimitsResponse resp = as(T_VIEWER).listLimits(ListLimitsRequest.newBuilder()
                .setServiceName(SVC).setPageSize(10).build());
        assertEquals(2, resp.getLimitsCount());
    }

    @Test
    void listLimitsPaginatesWithKeyset() {
        registerSearchSvc();
        create(T_EDITOR, "*", 1000);
        create(T_EDITOR, "cust_1", 10);
        create(T_EDITOR, "cust_2", 20);
        ListLimitsResponse first = as(T_EDITOR).listLimits(ListLimitsRequest.newBuilder()
                .setServiceName(SVC).setPageSize(2).build());
        assertEquals(2, first.getLimitsCount());
        assertTrue(!first.getNextPageToken().isEmpty());
        ListLimitsResponse second = as(T_EDITOR).listLimits(ListLimitsRequest.newBuilder()
                .setServiceName(SVC).setPageSize(2).setPageToken(first.getNextPageToken()).build());
        assertEquals(1, second.getLimitsCount());
        assertTrue(second.getNextPageToken().isEmpty());
    }

    @Test
    void negativeLimitIsInvalidArgumentWithField() {
        registerSearchSvc();
        StatusRuntimeException ex = assertThrows(StatusRuntimeException.class, () ->
                as(T_EDITOR).createLimit(CreateLimitRequest.newBuilder()
                        .setKey(key("cust_7", "requests_per_min")).setLimitValue(-5)
                        .setTimeUnit(TimeUnit.MINUTE).build()));
        assertEquals(Status.Code.INVALID_ARGUMENT, ex.getStatus().getCode());
        assertEquals("limit_value", ex.getTrailers().get(AppException.FIELD_KEY));
    }

    @Test
    void unspecifiedTimeUnitIsInvalidArgument() {
        registerSearchSvc();
        assertEquals(Status.Code.INVALID_ARGUMENT, codeOf(() ->
                as(T_EDITOR).createLimit(CreateLimitRequest.newBuilder()
                        .setKey(key("cust_7", "requests_per_min")).setLimitValue(10).build())));
    }

    @Test
    void rbacDeniesEditorOfAnotherService() {
        registerSearchSvc();
        assertEquals(Status.Code.PERMISSION_DENIED, codeOf(() -> create(T_BILLING, "cust_42", 5000)));
    }

    @Test
    void viewerMayNotWrite() {
        registerSearchSvc();
        assertEquals(Status.Code.PERMISSION_DENIED, codeOf(() -> create(T_VIEWER, "cust_42", 5000)));
    }

    @Test
    void anonymousCallIsUnauthenticated() {
        assertEquals(Status.Code.UNAUTHENTICATED, codeOf(() ->
                anonymous().listLimits(ListLimitsRequest.newBuilder().setServiceName(SVC).build())));
    }

    @Test
    void auditHistoryIsNewestFirstWithBeforeAfter() {
        registerSearchSvc();
        create(T_EDITOR, "cust_42", 5000);
        long configId = as(T_EDITOR).getLimit(GetLimitRequest.newBuilder()
                .setKey(key("cust_42", "requests_per_min")).build()).getLimit().getConfigId();
        as(T_EDITOR).updateLimit(UpdateLimitRequest.newBuilder()
                .setKey(key("cust_42", "requests_per_min")).setLimitValue(6000)
                .setTimeUnit(TimeUnit.MINUTE).build());

        List<AuditEntry> entries = as(T_VIEWER).listAuditEntries(ListAuditEntriesRequest.newBuilder()
                .setServiceName(SVC).setConfigId(configId).build()).getEntriesList();
        assertEquals(2, entries.size());
        assertEquals("UPDATE", entries.get(0).getOperation());
        assertEquals("alice@corp", entries.get(0).getChangedBy());
        assertEquals(5000.0, entries.get(0).getOldRow().getFieldsOrThrow("limit_value").getNumberValue());
        assertEquals(6000.0, entries.get(0).getNewRow().getFieldsOrThrow("limit_value").getNumberValue());
        assertEquals("INSERT", entries.get(1).getOperation());
    }

    @Test
    void deleteFallsBackToDefaultOnResolve() {
        registerSearchSvc();
        create(T_EDITOR, "*", 1000);
        create(T_EDITOR, "cust_42", 5000);
        as(T_EDITOR).deleteLimit(DeleteLimitRequest.newBuilder()
                .setKey(key("cust_42", "requests_per_min")).build());

        GetLimitResponse resolved = as(T_EDITOR).getLimit(GetLimitRequest.newBuilder()
                .setKey(key("cust_42", "requests_per_min")).setResolve(true).build());
        assertTrue(resolved.getIsDefault());
        assertEquals(1000, resolved.getLimit().getLimitValue());
    }

    @Test
    void deleteMissingIsIdempotentWithAllowMissing() {
        registerSearchSvc();
        // allow_missing => OK
        as(T_EDITOR).deleteLimit(DeleteLimitRequest.newBuilder()
                .setKey(key("ghost", "requests_per_min")).setAllowMissing(true).build());
        // without it => NOT_FOUND
        assertEquals(Status.Code.NOT_FOUND, codeOf(() -> as(T_EDITOR).deleteLimit(
                DeleteLimitRequest.newBuilder().setKey(key("ghost", "requests_per_min")).build())));
    }
}
