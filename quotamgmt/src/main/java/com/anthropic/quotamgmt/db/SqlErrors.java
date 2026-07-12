package com.anthropic.quotamgmt.db;

import com.anthropic.quotamgmt.error.AppException;
import io.grpc.Status;

import java.sql.SQLException;

/**
 * Translates Postgres {@link SQLException}s into the API's typed
 * {@link AppException}s / gRPC codes (design/quotamgmt.md §3.10). SQLState codes
 * are the standard Postgres class values.
 */
public final class SqlErrors {

    private static final String UNIQUE_VIOLATION = "23505";
    private static final String FOREIGN_KEY_VIOLATION = "23503";
    private static final String CHECK_VIOLATION = "23514";
    private static final String NOT_NULL_VIOLATION = "23502";
    private static final String SERIALIZATION_FAILURE = "40001";
    private static final String DEADLOCK_DETECTED = "40P01";
    private static final String CONNECTION_CLASS = "08"; // connection exception class

    private SqlErrors() {
    }

    public static AppException translate(SQLException e) {
        String state = e.getSQLState();
        if (state == null) {
            return AppException.of(Status.Code.INTERNAL, "database error: " + e.getMessage(), e);
        }
        return switch (state) {
            case UNIQUE_VIOLATION -> AppException.of(Status.Code.ALREADY_EXISTS,
                    "resource already exists", e);
            case FOREIGN_KEY_VIOLATION -> AppException.of(Status.Code.FAILED_PRECONDITION,
                    "referenced service is not registered", e);
            case CHECK_VIOLATION, NOT_NULL_VIOLATION -> AppException.of(Status.Code.INVALID_ARGUMENT,
                    "constraint violation: " + e.getMessage(), e);
            case SERIALIZATION_FAILURE, DEADLOCK_DETECTED -> AppException.of(Status.Code.ABORTED,
                    "serialization failure; retry", e);
            default -> {
                if (state.startsWith(CONNECTION_CLASS)) {
                    yield AppException.of(Status.Code.UNAVAILABLE,
                            "database unavailable", e);
                }
                yield AppException.of(Status.Code.INTERNAL, "database error: " + e.getMessage(), e);
            }
        };
    }
}
