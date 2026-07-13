package com.anthropic.quotamgmt.config;

/**
 * Runtime configuration, resolved from environment variables (with JVM
 * system-property overrides) and sensible local-dev defaults.
 *
 * <p>Postgres connection settings follow the conventional {@code PG*} env vars so
 * the same variables drive {@code psql} and this service. In production the
 * dedicated {@code quotamanager} role is used (design/quotamgmt.md §9.1); for
 * local testing the {@code postgres} superuser is fine.
 */
public final class AppConfig {

    private final String dbHost;
    private final int dbPort;
    private final String dbName;
    private final String dbUser;
    private final String dbPassword;
    private final int maxPoolSize;
    private final int grpcPort;

    private AppConfig(String dbHost, int dbPort, String dbName, String dbUser,
                      String dbPassword, int maxPoolSize, int grpcPort) {
        this.dbHost = dbHost;
        this.dbPort = dbPort;
        this.dbName = dbName;
        this.dbUser = dbUser;
        this.dbPassword = dbPassword;
        this.maxPoolSize = maxPoolSize;
        this.grpcPort = grpcPort;
    }

    /** Build config from the environment / system properties. */
    public static AppConfig fromEnvironment() {
        return new AppConfig(
                get("PGHOST", "quotamgmt.db.host", "localhost"),
                Integer.parseInt(get("PGPORT", "quotamgmt.db.port", "5432")),
                get("PGDATABASE", "quotamgmt.db.name", "quota"),
                get("PGUSER", "quotamgmt.db.user", "postgres"),
                get("PGPASSWORD", "quotamgmt.db.password", "postgres"),
                Integer.parseInt(get("QUOTAMGMT_DB_POOL", "quotamgmt.db.pool", "8")),
                Integer.parseInt(get("QUOTAMGMT_PORT", "quotamgmt.port", "8443")));
    }

    /** JVM system property wins over env var, which wins over the default. */
    private static String get(String env, String prop, String def) {
        String p = System.getProperty(prop);
        if (p != null && !p.isEmpty()) {
            return p;
        }
        String e = System.getenv(env);
        if (e != null && !e.isEmpty()) {
            return e;
        }
        return def;
    }

    public String jdbcUrl() {
        return "jdbc:postgresql://" + dbHost + ":" + dbPort + "/" + dbName;
    }

    public String dbUser() {
        return dbUser;
    }

    public String dbPassword() {
        return dbPassword;
    }

    public int maxPoolSize() {
        return maxPoolSize;
    }

    public int grpcPort() {
        return grpcPort;
    }
}
