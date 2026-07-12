package com.anthropic.quotamgmt.validation;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quota.common.v1.TimeUnit;
import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Status;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** Unit tests for the §3.8 validation rules — no database. */
class LimitValidatorTest {

    private static LimitKey key(String svc, String cust, String rlid) {
        return LimitKey.newBuilder()
                .setServiceName(svc).setCustomerId(cust).setRateLimitId(rlid).build();
    }

    private static AppException expectInvalid(Runnable r) {
        AppException e = assertThrows(AppException.class, r::run);
        assertEquals(Status.Code.INVALID_ARGUMENT, e.code());
        return e;
    }

    @Test
    void acceptsValidWrite() {
        assertDoesNotThrow(() -> LimitValidator.validateLimitWrite(
                key("search-svc", "cust_42", "requests_per_min"), 1000, TimeUnit.MINUTE));
    }

    @Test
    void acceptsDefaultCustomerMarker() {
        assertDoesNotThrow(() -> LimitValidator.validateKey(key("search-svc", "*", "req")));
    }

    @Test
    void acceptsZeroLimitAsDenyAll() {
        // 0 is a valid explicit deny-all, distinct from an absent row.
        assertDoesNotThrow(() -> LimitValidator.validateLimitValue(0));
    }

    @Test
    void rejectsNegativeLimit() {
        AppException e = expectInvalid(() -> LimitValidator.validateLimitValue(-5));
        assertEquals("limit_value", e.field());
    }

    @Test
    void rejectsUnspecifiedTimeUnit() {
        AppException e = expectInvalid(() -> LimitValidator.validateTimeUnit(TimeUnit.TIME_UNIT_UNSPECIFIED));
        assertEquals("time_unit", e.field());
    }

    @Test
    void rejectsEmptyServiceName() {
        AppException e = expectInvalid(() -> LimitValidator.validateServiceName(""));
        assertEquals("service_name", e.field());
    }

    @Test
    void rejectsMalformedServiceName() {
        expectInvalid(() -> LimitValidator.validateServiceName("Search_Svc")); // uppercase + underscore
        expectInvalid(() -> LimitValidator.validateServiceName("-leading-hyphen"));
    }

    @Test
    void rejectsEmptyCustomerId() {
        AppException e = expectInvalid(() -> LimitValidator.validateCustomerId(""));
        assertEquals("customer_id", e.field());
    }

    @Test
    void rejectsOverlongCustomerId() {
        String tooLong = "c".repeat(129);
        expectInvalid(() -> LimitValidator.validateCustomerId(tooLong));
    }

    @Test
    void rejectsMalformedRateLimitId() {
        expectInvalid(() -> LimitValidator.validateRateLimitId("Requests/Min"));
    }

    @Test
    void clampsPageSize() {
        assertEquals(100, LimitValidator.clampPageSize(0));    // default
        assertEquals(100, LimitValidator.clampPageSize(-1));   // default
        assertEquals(50, LimitValidator.clampPageSize(50));    // as-is
        assertEquals(1000, LimitValidator.clampPageSize(5000)); // max
    }
}
