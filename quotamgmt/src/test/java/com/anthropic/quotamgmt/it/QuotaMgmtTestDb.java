package com.anthropic.quotamgmt.it;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Provisions an isolated Postgres database for integration tests so they never
 * touch the developer's {@code quota} database. On {@link #setUp()} it (re)creates
 * {@code quota_test} from the maintenance DB and applies {@code schema/postgres.sql};
 * {@link #truncate()} clears the tables between tests.
 *
 * <p>Connection settings come from {@code PG*} env vars with local-dev defaults
 * (postgres superuser). Set {@code PGHOST}/{@code PGPORT}/{@code PGUSER}/
 * {@code PGPASSWORD} to point elsewhere.
 */
public final class QuotaMgmtTestDb {

    private static final String TEST_DB = "quota_test";

    private final String host = env("PGHOST", "localhost");
    private final String port = env("PGPORT", "5432");
    private final String user = env("PGUSER", "postgres");
    private final String password = env("PGPASSWORD", "postgres");

    private HikariDataSource dataSource;

    public HikariDataSource dataSource() {
        return dataSource;
    }

    /** Recreate the test DB, load the schema, and open a pooled DataSource. */
    public void setUp() throws Exception {
        recreateDatabase();
        applySchema();
        dataSource = pool(jdbc(TEST_DB));
    }

    public void tearDown() {
        if (dataSource != null) {
            dataSource.close();
        }
    }

    /** Wipe all rows (and reset identities) between tests. */
    public void truncate() {
        try (Connection c = dataSource.getConnection(); Statement s = c.createStatement()) {
            s.execute("TRUNCATE limit_config, limit_config_audit, service RESTART IDENTITY CASCADE");
        } catch (SQLException e) {
            throw new RuntimeException("truncate failed", e);
        }
    }

    /** True if Postgres is reachable — used to skip the suite gracefully if not. */
    public boolean reachable() {
        try (Connection c = DriverManager.getConnection(jdbc("postgres"), user, password)) {
            return c.isValid(2);
        } catch (SQLException e) {
            return false;
        }
    }

    private void recreateDatabase() throws SQLException {
        try (Connection c = DriverManager.getConnection(jdbc("postgres"), user, password);
             Statement s = c.createStatement()) {
            // Terminate any lingering connections, then drop + recreate.
            s.execute("DROP DATABASE IF EXISTS " + TEST_DB + " WITH (FORCE)");
            s.execute("CREATE DATABASE " + TEST_DB);
        }
    }

    private void applySchema() throws Exception {
        String ddl = Files.readString(schemaPath());
        try (Connection c = DriverManager.getConnection(jdbc(TEST_DB), user, password);
             Statement s = c.createStatement()) {
            // The whole file (multiple statements + a dollar-quoted function) runs as
            // one simple-protocol execute.
            s.execute(ddl);
        }
    }

    private static Path schemaPath() {
        for (Path candidate : new Path[]{Path.of("../schema/postgres.sql"), Path.of("schema/postgres.sql")}) {
            if (Files.exists(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("cannot locate schema/postgres.sql from " + Path.of(".").toAbsolutePath());
    }

    private String jdbc(String db) {
        return "jdbc:postgresql://" + host + ":" + port + "/" + db;
    }

    private HikariDataSource pool(String url) {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl(url);
        cfg.setUsername(user);
        cfg.setPassword(password);
        cfg.setMaximumPoolSize(4);
        cfg.setPoolName("quotamgmt-it");
        return new HikariDataSource(cfg);
    }

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isEmpty()) ? def : v;
    }
}
