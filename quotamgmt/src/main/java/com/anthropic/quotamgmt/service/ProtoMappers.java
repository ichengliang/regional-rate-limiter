package com.anthropic.quotamgmt.service;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quota.common.v1.TimeUnit;
import com.anthropic.quotamgmt.error.AppException;
import com.anthropic.quotamgmt.store.AuditRow;
import com.anthropic.quotamgmt.store.LimitRow;
import com.anthropic.quotamgmt.store.ServiceRow;
import com.anthropic.quotamgmt.v1.AuditEntry;
import com.anthropic.quotamgmt.v1.Limit;
import com.anthropic.quotamgmt.v1.ServiceInfo;
import com.google.protobuf.InvalidProtocolBufferException;
import com.google.protobuf.Struct;
import com.google.protobuf.Timestamp;
import com.google.protobuf.util.JsonFormat;
import io.grpc.Status;

/**
 * Converts between the Postgres domain rows and the proto wire types. Kept in one
 * place so the enum mapping (proto {@link TimeUnit} ↔ Postgres {@code time_unit}
 * label) and the JSONB → {@link Struct} conversion (audit old_row/new_row) are
 * defined once.
 */
public final class ProtoMappers {

    private ProtoMappers() {
    }

    public static Limit toLimit(LimitRow row) {
        return Limit.newBuilder()
                .setKey(LimitKey.newBuilder()
                        .setServiceName(row.serviceName())
                        .setCustomerId(row.customerId())
                        .setRateLimitId(row.rateLimitId()))
                .setLimitValue(row.limitValue())
                .setTimeUnit(toTimeUnit(row.timeUnit()))
                .setConfigId(row.configId())
                .build();
    }

    public static ServiceInfo toServiceInfo(ServiceRow row) {
        return ServiceInfo.newBuilder()
                .setServiceName(row.serviceName())
                .setDisplayName(row.displayName())
                .setOwner(row.owner())
                .build();
    }

    public static AuditEntry toAuditEntry(AuditRow row) {
        AuditEntry.Builder b = AuditEntry.newBuilder()
                .setAuditId(row.auditId())
                .setConfigId(row.configId())
                .setOperation(row.operation())
                .setChangedBy(row.changedBy());
        if (row.oldRowJson() != null) {
            b.setOldRow(jsonToStruct(row.oldRowJson()));
        }
        if (row.newRowJson() != null) {
            b.setNewRow(jsonToStruct(row.newRowJson()));
        }
        if (row.changedAt() != null) {
            b.setChangedAt(Timestamp.newBuilder()
                    .setSeconds(row.changedAt().getEpochSecond())
                    .setNanos(row.changedAt().getNano()));
        }
        return b.build();
    }

    /** Postgres enum label → proto TimeUnit. Labels match the proto names. */
    public static TimeUnit toTimeUnit(String label) {
        return switch (label) {
            case "MINUTE" -> TimeUnit.MINUTE;
            case "DAY" -> TimeUnit.DAY;
            case "MONTH" -> TimeUnit.MONTH;
            default -> throw AppException.of(Status.Code.INTERNAL,
                    "unknown time_unit label from database: " + label);
        };
    }

    /** Proto TimeUnit → Postgres enum label (validation has already rejected UNSPECIFIED). */
    public static String toTimeUnitLabel(TimeUnit unit) {
        return unit.name();
    }

    private static Struct jsonToStruct(String json) {
        Struct.Builder b = Struct.newBuilder();
        try {
            JsonFormat.parser().merge(json, b);
        } catch (InvalidProtocolBufferException e) {
            throw AppException.of(Status.Code.INTERNAL, "cannot parse audit JSON payload", e);
        }
        return b.build();
    }
}
