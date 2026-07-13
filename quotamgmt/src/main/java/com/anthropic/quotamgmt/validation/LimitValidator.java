package com.anthropic.quotamgmt.validation;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quota.common.v1.TimeUnit;
import com.anthropic.quotamgmt.error.AppException;

import java.util.regex.Pattern;

/**
 * Input validation for the control-plane API (design/quotamgmt.md §3.8). Every
 * rule mirrors a Postgres constraint so a violation is caught with a precise
 * {@code field} before any DB round-trip. Violations throw
 * {@link AppException#invalidArgument}.
 *
 * <p>Pure and stateless — no DB access. FK existence of {@code service_name} is
 * enforced by the database, not here (surfaced as {@code FAILED_PRECONDITION}).
 */
public final class LimitValidator {

    /** Reserved literal marking a per-(service, rate_limit_id) default row (§3.6). */
    public static final String DEFAULT_CUSTOMER = "*";

    private static final Pattern SERVICE_NAME = Pattern.compile("^[a-z0-9][a-z0-9-]{0,62}$");
    private static final Pattern RATE_LIMIT_ID = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,127}$");
    private static final int CUSTOMER_ID_MAX = 128;

    static final int PAGE_SIZE_MAX = 1000;
    static final int PAGE_SIZE_DEFAULT = 100;

    private LimitValidator() {
    }

    /** Validate a limit-write payload: key + value + time unit. */
    public static void validateLimitWrite(LimitKey key, long limitValue, TimeUnit timeUnit) {
        validateKey(key);
        validateLimitValue(limitValue);
        validateTimeUnit(timeUnit);
    }

    /** Validate the identity tuple (used by writes and by Get/Delete). */
    public static void validateKey(LimitKey key) {
        if (key == null) {
            throw AppException.invalidArgument("key", "key is required");
        }
        validateServiceName(key.getServiceName());
        validateCustomerId(key.getCustomerId());
        validateRateLimitId(key.getRateLimitId());
    }

    public static void validateServiceName(String serviceName) {
        if (serviceName == null || serviceName.isEmpty()) {
            throw AppException.invalidArgument("service_name", "service_name is required");
        }
        if (!SERVICE_NAME.matcher(serviceName).matches()) {
            throw AppException.invalidArgument("service_name",
                    "service_name must match ^[a-z0-9][a-z0-9-]{0,62}$");
        }
    }

    public static void validateCustomerId(String customerId) {
        if (customerId == null || customerId.isEmpty()) {
            throw AppException.invalidArgument("customer_id", "customer_id is required");
        }
        // '*' is allowed only as the default marker; a real id may not be '*'.
        if (customerId.equals(DEFAULT_CUSTOMER)) {
            return;
        }
        if (customerId.length() > CUSTOMER_ID_MAX) {
            throw AppException.invalidArgument("customer_id",
                    "customer_id must be <= " + CUSTOMER_ID_MAX + " characters");
        }
    }

    public static void validateRateLimitId(String rateLimitId) {
        if (rateLimitId == null || rateLimitId.isEmpty()) {
            throw AppException.invalidArgument("rate_limit_id", "rate_limit_id is required");
        }
        if (!RATE_LIMIT_ID.matcher(rateLimitId).matches()) {
            throw AppException.invalidArgument("rate_limit_id",
                    "rate_limit_id must match ^[a-z0-9][a-z0-9._-]{0,127}$");
        }
    }

    public static void validateLimitValue(long limitValue) {
        // 0 is valid (explicit deny-all); negative mirrors CHECK (limit_value >= 0).
        if (limitValue < 0) {
            throw AppException.invalidArgument("limit_value", "limit_value must be >= 0");
        }
    }

    public static void validateTimeUnit(TimeUnit timeUnit) {
        if (timeUnit == null
                || timeUnit == TimeUnit.TIME_UNIT_UNSPECIFIED
                || timeUnit == TimeUnit.UNRECOGNIZED) {
            throw AppException.invalidArgument("time_unit",
                    "time_unit must be one of MINUTE, DAY, MONTH");
        }
    }

    /** Clamp a requested page size into {@code [1, 1000]}, defaulting 0/unset to 100. */
    public static int clampPageSize(int requested) {
        if (requested <= 0) {
            return PAGE_SIZE_DEFAULT;
        }
        return Math.min(requested, PAGE_SIZE_MAX);
    }
}
