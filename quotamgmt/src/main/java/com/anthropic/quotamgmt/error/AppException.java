package com.anthropic.quotamgmt.error;

import io.grpc.Metadata;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;

/**
 * A typed, layer-agnostic error carrying the gRPC {@link Status.Code} it should
 * surface as (design/quotamgmt.md §3.10). Validation, authorization and the data
 * store all throw this; the gRPC layer translates it once via {@link #toStatusRuntimeException()}.
 *
 * <p>For {@code INVALID_ARGUMENT} an optional machine-readable {@code field}
 * identifies the offending input (§3.8); it is echoed in the message and attached
 * as a response trailer so clients can react programmatically.
 */
public final class AppException extends RuntimeException {

    /** Trailer key carrying the offending field name for INVALID_ARGUMENT. */
    public static final Metadata.Key<String> FIELD_KEY =
            Metadata.Key.of("field", Metadata.ASCII_STRING_MARSHALLER);

    private final Status.Code code;
    private final String field; // nullable

    private AppException(Status.Code code, String field, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.field = field;
    }

    public static AppException of(Status.Code code, String message) {
        return new AppException(code, null, message, null);
    }

    public static AppException of(Status.Code code, String message, Throwable cause) {
        return new AppException(code, null, message, cause);
    }

    /** INVALID_ARGUMENT with the offending field (§3.8). */
    public static AppException invalidArgument(String field, String message) {
        return new AppException(Status.Code.INVALID_ARGUMENT, field, message, null);
    }

    public Status.Code code() {
        return code;
    }

    public String field() {
        return field;
    }

    public StatusRuntimeException toStatusRuntimeException() {
        Status status = code.toStatus().withDescription(getMessage());
        if (getCause() != null) {
            status = status.withCause(getCause());
        }
        Metadata trailers = new Metadata();
        if (field != null) {
            trailers.put(FIELD_KEY, field);
        }
        return status.asRuntimeException(trailers);
    }
}
