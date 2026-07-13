package com.anthropic.quotamgmt.store;

import java.time.Instant;

/**
 * A row of {@code limit_config_audit} (design/quotamgmt.md §3.9, §4.4).
 * {@code oldRowJson}/{@code newRowJson} are the raw JSONB payloads (nullable):
 * {@code old_row} is null on INSERT, {@code new_row} is null on DELETE.
 */
public record AuditRow(
        long auditId,
        long configId,
        String operation,
        String oldRowJson,
        String newRowJson,
        String changedBy,
        Instant changedAt) {
}
