package com.anthropic.quotamgmt.store;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quotamgmt.db.SqlErrors;
import com.anthropic.quotamgmt.db.SqlFunction;
import com.anthropic.quotamgmt.error.AppException;
import com.anthropic.quotamgmt.paging.Page;
import com.anthropic.quotamgmt.paging.PageToken;
import io.grpc.Status;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Data access for {@code limit_config} (design/quotamgmt.md §4). Every mutation
 * runs through the audited transaction path — {@code SET LOCAL app.actor} then
 * the write, with the trigger populating {@code limit_config_audit} (§4.4). The
 * app never writes the audit table itself, so audit completeness is structural.
 */
public final class LimitRepository {

    private static final String COLS = "id, service_name, customer_id, rate_limit_id, limit_value, time_unit";

    private final DataSource dataSource;

    public LimitRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** Exact-tuple fetch (design §3.5, resolve=false). */
    public Optional<LimitRow> getExact(LimitKey key) {
        String sql = "SELECT " + COLS + " FROM limit_config"
                + " WHERE service_name = ? AND customer_id = ? AND rate_limit_id = ?";
        return query(sql, ps -> {
            ps.setString(1, key.getServiceName());
            ps.setString(2, key.getCustomerId());
            ps.setString(3, key.getRateLimitId());
        });
    }

    /**
     * Exact-then-default resolution (design §4.2): the exact customer row if
     * present, else the {@code '*'} default, else empty (unconfigured → allow).
     * This is byte-for-byte the query the data plane runs on a cache miss.
     */
    public Optional<LimitRow> resolve(String serviceName, String customerId, String rateLimitId) {
        String sql = "SELECT " + COLS + " FROM limit_config"
                + " WHERE service_name = ? AND rate_limit_id = ?"
                + "   AND customer_id IN (?, '*')"
                + " ORDER BY (customer_id = '*')" // FALSE (exact) sorts before TRUE (default)
                + " LIMIT 1";
        return query(sql, ps -> {
            ps.setString(1, serviceName);
            ps.setString(2, rateLimitId);
            ps.setString(3, customerId);
        });
    }

    /**
     * Insert one row (design §3.2). {@code ALREADY_EXISTS} on a duplicate tuple,
     * {@code FAILED_PRECONDITION} if the service is unregistered (FK).
     */
    public LimitRow create(String actor, LimitKey key, long limitValue, String timeUnit) {
        String sql = "INSERT INTO limit_config"
                + " (service_name, customer_id, rate_limit_id, limit_value, time_unit)"
                + " VALUES (?, ?, ?, ?, ?::time_unit)"
                + " RETURNING " + COLS;
        return inAuditedTx(actor, conn -> {
            try (PreparedStatement ps = conn.prepareStatement(sql)) {
                ps.setString(1, key.getServiceName());
                ps.setString(2, key.getCustomerId());
                ps.setString(3, key.getRateLimitId());
                ps.setLong(4, limitValue);
                ps.setString(5, timeUnit);
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    return map(rs);
                }
            } catch (SQLException e) {
                throw translateWrite(e, key);
            }
        });
    }

    /**
     * Update an existing row's value/unit (design §3.3). If absent:
     * {@code NOT_FOUND}, unless {@code createIfAbsent} in which case it upserts
     * (and the trigger records an INSERT, not UPDATE, audit row).
     */
    public LimitRow update(String actor, LimitKey key, long limitValue, String timeUnit,
                           boolean createIfAbsent) {
        return inAuditedTx(actor, conn -> createIfAbsent
                ? upsert(conn, key, limitValue, timeUnit)
                : updateExisting(conn, key, limitValue, timeUnit));
    }

    private LimitRow updateExisting(Connection conn, LimitKey key, long limitValue, String timeUnit)
            throws SQLException {
        String sql = "UPDATE limit_config SET limit_value = ?, time_unit = ?::time_unit"
                + " WHERE service_name = ? AND customer_id = ? AND rate_limit_id = ?"
                + " RETURNING " + COLS;
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, limitValue);
            ps.setString(2, timeUnit);
            ps.setString(3, key.getServiceName());
            ps.setString(4, key.getCustomerId());
            ps.setString(5, key.getRateLimitId());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw AppException.of(Status.Code.NOT_FOUND,
                            "limit " + tuple(key) + " does not exist; use create_if_absent to upsert");
                }
                return map(rs);
            }
        }
    }

    private LimitRow upsert(Connection conn, LimitKey key, long limitValue, String timeUnit)
            throws SQLException {
        // ON CONFLICT DO UPDATE fires the UPDATE trigger on an existing row and the
        // INSERT trigger on a new one — matching the audit semantics of §3.3.
        String sql = "INSERT INTO limit_config"
                + " (service_name, customer_id, rate_limit_id, limit_value, time_unit)"
                + " VALUES (?, ?, ?, ?, ?::time_unit)"
                + " ON CONFLICT (service_name, customer_id, rate_limit_id)"
                + " DO UPDATE SET limit_value = EXCLUDED.limit_value, time_unit = EXCLUDED.time_unit"
                + " RETURNING " + COLS;
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, key.getServiceName());
            ps.setString(2, key.getCustomerId());
            ps.setString(3, key.getRateLimitId());
            ps.setLong(4, limitValue);
            ps.setString(5, timeUnit);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return map(rs);
            }
        } catch (SQLException e) {
            throw translateWrite(e, key);
        }
    }

    /**
     * Delete a row (design §3.4). Returns true if a row was deleted. A missing
     * row throws {@code NOT_FOUND} unless {@code allowMissing}, in which case it
     * returns false and — because nothing changed — no audit row is written.
     */
    public boolean delete(String actor, LimitKey key, boolean allowMissing) {
        String sql = "DELETE FROM limit_config"
                + " WHERE service_name = ? AND customer_id = ? AND rate_limit_id = ?";
        return inAuditedTx(actor, conn -> {
            try (PreparedStatement ps = conn.prepareStatement(sql)) {
                ps.setString(1, key.getServiceName());
                ps.setString(2, key.getCustomerId());
                ps.setString(3, key.getRateLimitId());
                int affected = ps.executeUpdate();
                if (affected == 0 && !allowMissing) {
                    throw AppException.of(Status.Code.NOT_FOUND,
                            "limit " + tuple(key) + " does not exist");
                }
                return affected > 0;
            }
        });
    }

    /** Keyset-paginated list, always scoped to one service (design §3.5, §7). */
    public Page<LimitRow> list(String serviceName, String customerId, String rateLimitId,
                               int pageSize, String pageToken) {
        long cursor = PageToken.decodeLong(pageToken, 0L);
        StringBuilder sql = new StringBuilder("SELECT " + COLS + " FROM limit_config"
                + " WHERE service_name = ? AND id > ?");
        List<Object> params = new ArrayList<>();
        params.add(serviceName);
        params.add(cursor);
        if (customerId != null && !customerId.isEmpty()) {
            sql.append(" AND customer_id = ?");
            params.add(customerId);
        }
        if (rateLimitId != null && !rateLimitId.isEmpty()) {
            sql.append(" AND rate_limit_id = ?");
            params.add(rateLimitId);
        }
        sql.append(" ORDER BY id LIMIT ?");
        params.add(pageSize + 1); // fetch one extra to detect a next page

        List<LimitRow> rows = queryList(sql.toString(), params);
        return toPage(rows, pageSize);
    }

    private static Page<LimitRow> toPage(List<LimitRow> rows, int pageSize) {
        if (rows.size() > pageSize) {
            List<LimitRow> page = rows.subList(0, pageSize);
            String next = PageToken.encodeLong(page.get(page.size() - 1).configId());
            return new Page<>(List.copyOf(page), next);
        }
        return new Page<>(List.copyOf(rows), "");
    }

    // ---------- helpers ----------

    private Optional<LimitRow> query(String sql, StatementBinder binder) {
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            binder.bind(ps);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? Optional.of(map(rs)) : Optional.empty();
            }
        } catch (SQLException e) {
            throw SqlErrors.translate(e);
        }
    }

    private List<LimitRow> queryList(String sql, List<Object> params) {
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            try (ResultSet rs = ps.executeQuery()) {
                List<LimitRow> rows = new ArrayList<>();
                while (rs.next()) {
                    rows.add(map(rs));
                }
                return rows;
            }
        } catch (SQLException e) {
            throw SqlErrors.translate(e);
        }
    }

    /**
     * Run {@code body} in a single transaction with {@code app.actor} set via
     * {@code SET LOCAL} (design §4.4). The trigger raises if the actor is unset,
     * so an unattributed write is impossible.
     */
    private <T> T inAuditedTx(String actor, SqlFunction<T> body) {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                setActor(conn, actor);
                T result = body.apply(conn);
                conn.commit();
                return result;
            } catch (SQLException | RuntimeException e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw SqlErrors.translate(e);
        }
    }

    private static void setActor(Connection conn, String actor) throws SQLException {
        // is_local=true == SET LOCAL: scoped to this transaction, safe under pooling.
        try (PreparedStatement ps = conn.prepareStatement("SELECT set_config('app.actor', ?, true)")) {
            ps.setString(1, actor);
            ps.execute();
        }
    }

    private static AppException translateWrite(SQLException e, LimitKey key) {
        AppException translated = SqlErrors.translate(e);
        return switch (translated.code()) {
            case ALREADY_EXISTS -> AppException.of(Status.Code.ALREADY_EXISTS,
                    "limit " + tuple(key) + " already exists; use UpdateLimit", e);
            case FAILED_PRECONDITION -> AppException.of(Status.Code.FAILED_PRECONDITION,
                    "service '" + key.getServiceName() + "' is not registered", e);
            default -> translated;
        };
    }

    private static String tuple(LimitKey key) {
        return "(" + key.getServiceName() + ", " + key.getCustomerId() + ", "
                + key.getRateLimitId() + ")";
    }

    private static LimitRow map(ResultSet rs) throws SQLException {
        return new LimitRow(
                rs.getLong("id"),
                rs.getString("service_name"),
                rs.getString("customer_id"),
                rs.getString("rate_limit_id"),
                rs.getLong("limit_value"),
                rs.getString("time_unit"));
    }

    @FunctionalInterface
    private interface StatementBinder {
        void bind(PreparedStatement ps) throws SQLException;
    }
}
