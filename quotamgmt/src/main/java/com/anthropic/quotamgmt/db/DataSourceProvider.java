package com.anthropic.quotamgmt.db;

import com.anthropic.quotamgmt.config.AppConfig;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import javax.sql.DataSource;

/**
 * Builds the pooled Postgres {@link DataSource} (design/quotamgmt.md §9.1). The
 * pool is small — write QPS is tiny — and safe to pool because the audit actor is
 * set with {@code SET LOCAL} (transaction-scoped), so it never leaks across
 * pooled checkouts (§4.4, §9.1).
 */
public final class DataSourceProvider {

    private DataSourceProvider() {
    }

    public static HikariDataSource create(AppConfig config) {
        HikariConfig hikari = new HikariConfig();
        hikari.setJdbcUrl(config.jdbcUrl());
        hikari.setUsername(config.dbUser());
        hikari.setPassword(config.dbPassword());
        hikari.setMaximumPoolSize(config.maxPoolSize());
        hikari.setPoolName("quotamgmt-pg");
        // Writes are single-statement transactions; keep autocommit on by default
        // and flip it off explicitly for the audited write path.
        hikari.setAutoCommit(true);
        return new HikariDataSource(hikari);
    }
}
