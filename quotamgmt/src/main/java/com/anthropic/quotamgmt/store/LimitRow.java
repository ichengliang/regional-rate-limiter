package com.anthropic.quotamgmt.store;

/**
 * A row of {@code limit_config} (design/quotamgmt.md §4.1). {@code timeUnit} is
 * the Postgres enum label ({@code MINUTE|DAY|MONTH}).
 */
public record LimitRow(
        long configId,
        String serviceName,
        String customerId,
        String rateLimitId,
        long limitValue,
        String timeUnit) {

    /** True if this is a per-(service, rate_limit_id) default row (§3.6). */
    public boolean isDefault() {
        return "*".equals(customerId);
    }
}
