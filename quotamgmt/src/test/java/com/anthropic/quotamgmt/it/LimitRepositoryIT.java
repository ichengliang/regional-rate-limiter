package com.anthropic.quotamgmt.it;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quotamgmt.error.AppException;
import com.anthropic.quotamgmt.store.AuditRepository;
import com.anthropic.quotamgmt.store.AuditRow;
import com.anthropic.quotamgmt.store.LimitRepository;
import com.anthropic.quotamgmt.store.LimitRow;
import com.anthropic.quotamgmt.store.ServiceRepository;
import com.anthropic.quotamgmt.store.ServiceRow;
import io.grpc.Status;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Integration tests for the audited write path, the exact-then-default resolution
 * query, and the audit trigger — against a real Postgres (design/quotamgmt.md §4,
 * §11.1 "Schema/trigger tests" and "Resolution query tests").
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class LimitRepositoryIT {

    private final QuotaMgmtTestDb db = new QuotaMgmtTestDb();
    private LimitRepository limits;
    private ServiceRepository services;
    private AuditRepository audit;

    private static final String SVC = "search-svc";
    private static final String ACTOR = "alice@corp";

    @BeforeAll
    void setUp() throws Exception {
        Assumptions.assumeTrue(db.reachable(), "Postgres not reachable; skipping integration tests");
        db.setUp();
        limits = new LimitRepository(db.dataSource());
        services = new ServiceRepository(db.dataSource());
        audit = new AuditRepository(db.dataSource());
    }

    @AfterAll
    void tearDown() {
        db.tearDown();
    }

    @BeforeEach
    void reset() {
        db.truncate();
        services.register(new ServiceRow(SVC, "Search Service", "search-team"));
    }

    private static LimitKey key(String cust, String rlid) {
        return LimitKey.newBuilder().setServiceName(SVC).setCustomerId(cust).setRateLimitId(rlid).build();
    }

    @Test
    void createInsertsRowAndWritesInsertAudit() {
        LimitRow row = limits.create(ACTOR, key("cust_42", "requests_per_min"), 5000, "MINUTE");
        assertTrue(row.configId() > 0);
        assertEquals(5000, row.limitValue());

        List<AuditRow> entries = audit.list(SVC, Optional.empty(), Optional.of(row.configId()),
                Optional.empty(), 10, "").items();
        assertEquals(1, entries.size());
        assertEquals("INSERT", entries.get(0).operation());
        assertEquals(ACTOR, entries.get(0).changedBy());
        assertTrue(entries.get(0).oldRowJson() == null);
        assertTrue(entries.get(0).newRowJson().contains("5000"));
    }

    @Test
    void duplicateCreateIsAlreadyExists() {
        limits.create(ACTOR, key("cust_42", "requests_per_min"), 5000, "MINUTE");
        AppException e = assertThrows(AppException.class,
                () -> limits.create(ACTOR, key("cust_42", "requests_per_min"), 6000, "MINUTE"));
        assertEquals(Status.Code.ALREADY_EXISTS, e.code());
    }

    @Test
    void createForUnregisteredServiceIsFailedPrecondition() {
        LimitKey bad = LimitKey.newBuilder()
                .setServiceName("ghost-svc").setCustomerId("c").setRateLimitId("r").build();
        AppException e = assertThrows(AppException.class, () -> limits.create(ACTOR, bad, 1, "MINUTE"));
        assertEquals(Status.Code.FAILED_PRECONDITION, e.code());
    }

    @Test
    void updateWritesBeforeAfterAudit() {
        LimitRow created = limits.create(ACTOR, key("cust_42", "requests_per_min"), 5000, "MINUTE");
        LimitRow updated = limits.update("bob@corp", key("cust_42", "requests_per_min"), 6000, "MINUTE", false);
        assertEquals(created.configId(), updated.configId()); // config_id is stable
        assertEquals(6000, updated.limitValue());

        List<AuditRow> entries = audit.list(SVC, Optional.empty(), Optional.of(created.configId()),
                Optional.empty(), 10, "").items();
        assertEquals(2, entries.size()); // newest first: UPDATE then INSERT
        assertEquals("UPDATE", entries.get(0).operation());
        assertEquals("bob@corp", entries.get(0).changedBy());
        assertTrue(entries.get(0).oldRowJson().contains("5000"));
        assertTrue(entries.get(0).newRowJson().contains("6000"));
    }

    @Test
    void updateMissingWithoutCreateIfAbsentIsNotFound() {
        AppException e = assertThrows(AppException.class,
                () -> limits.update(ACTOR, key("ghost", "requests_per_min"), 1, "MINUTE", false));
        assertEquals(Status.Code.NOT_FOUND, e.code());
    }

    @Test
    void upsertCreatesWithInsertAudit() {
        LimitRow row = limits.update(ACTOR, key("cust_99", "requests_per_min"), 1234, "MINUTE", true);
        assertEquals(1234, row.limitValue());
        List<AuditRow> entries = audit.list(SVC, Optional.empty(), Optional.of(row.configId()),
                Optional.empty(), 10, "").items();
        assertEquals(1, entries.size());
        assertEquals("INSERT", entries.get(0).operation()); // upsert of an absent row audits as INSERT
    }

    @Test
    void deleteWritesDeleteAudit() {
        LimitRow row = limits.create(ACTOR, key("cust_42", "requests_per_min"), 5000, "MINUTE");
        assertTrue(limits.delete(ACTOR, key("cust_42", "requests_per_min"), false));
        List<AuditRow> entries = audit.list(SVC, Optional.empty(), Optional.of(row.configId()),
                Optional.empty(), 10, "").items();
        assertEquals("DELETE", entries.get(0).operation());
        assertTrue(entries.get(0).newRowJson() == null);
    }

    @Test
    void deleteMissingIsNotFoundUnlessAllowMissing() {
        AppException e = assertThrows(AppException.class,
                () -> limits.delete(ACTOR, key("ghost", "requests_per_min"), false));
        assertEquals(Status.Code.NOT_FOUND, e.code());

        // allow_missing: OK, and writes no audit row (nothing changed).
        assertFalse(limits.delete(ACTOR, key("ghost", "requests_per_min"), true));
        assertTrue(audit.list(SVC, Optional.empty(), Optional.empty(), Optional.empty(), 10, "")
                .items().isEmpty());
    }

    @Test
    void resolveExactWinsOverDefault() {
        limits.create(ACTOR, key("*", "requests_per_min"), 1000, "MINUTE");
        limits.create(ACTOR, key("cust_42", "requests_per_min"), 5000, "MINUTE");

        LimitRow exact = limits.resolve(SVC, "cust_42", "requests_per_min").orElseThrow();
        assertEquals(5000, exact.limitValue());
        assertFalse(exact.isDefault());

        LimitRow def = limits.resolve(SVC, "cust_99", "requests_per_min").orElseThrow();
        assertEquals(1000, def.limitValue());
        assertTrue(def.isDefault());
    }

    @Test
    void resolveNoRowIsEmpty() {
        assertTrue(limits.resolve(SVC, "nobody", "unknown_limit").isEmpty());
    }

    @Test
    void zeroLimitIsStoredAsDenyAll() {
        LimitRow row = limits.create(ACTOR, key("*", "requests_per_min"), 0, "MINUTE");
        assertEquals(0, row.limitValue());
        assertEquals(0, limits.resolve(SVC, "anyone", "requests_per_min").orElseThrow().limitValue());
    }

    @Test
    void rawInsertWithoutActorIsRejectedByTrigger() throws SQLException {
        // The fail-closed-for-writes guarantee (§4.4): a config write with no
        // app.actor raises, so an unattributed change is impossible.
        try (Connection c = db.dataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(
                     "INSERT INTO limit_config (service_name, customer_id, rate_limit_id, limit_value, time_unit)"
                             + " VALUES (?, ?, ?, ?, ?::time_unit)")) {
            ps.setString(1, SVC);
            ps.setString(2, "cust_x");
            ps.setString(3, "requests_per_min");
            ps.setLong(4, 10);
            ps.setString(5, "MINUTE");
            SQLException e = assertThrows(SQLException.class, ps::executeUpdate);
            assertTrue(e.getMessage().contains("app.actor"), "expected app.actor guard, got: " + e.getMessage());
        }
    }
}
