package com.anthropic.quotamgmt.db;

import java.sql.Connection;
import java.sql.SQLException;

/** A unit of work over a {@link Connection} that may throw {@link SQLException}. */
@FunctionalInterface
public interface SqlFunction<T> {
    T apply(Connection connection) throws SQLException;
}
