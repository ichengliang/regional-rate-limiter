package com.anthropic.quotamgmt.store;

import com.anthropic.quota.common.v1.LimitKey;
import com.anthropic.quotamgmt.db.SqlErrors;
import com.anthropic.quotamgmt.paging.Page;
import com.anthropic.quotamgmt.paging.PageToken;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Read access to {@code limit_config_audit} for the audit-browsing API
 * (design/quotamgmt.md §3.9). This is <em>not</em> the data-plane change-feed
 * (§5): it filters by {@code service_name}/{@code config_id} and is human-paced,
 * newest-first.
 *
 * <p>The audit table has no {@code service_name} column, so tenant scoping reads
 * it out of the JSONB snapshot — {@code coalesce(new_row, old_row)} — which is
 * present for every operation (new_row on INSERT/UPDATE, old_row on DELETE). This
 * keeps deleted limits' history queryable, which a join to {@code limit_config}
 * would lose.
 */
public final class AuditRepository {

    private static final String COLS =
            "audit_id, config_id, operation, old_row, new_row, changed_by, changed_at";
    private static final String SVC = "coalesce(new_row->>'service_name', old_row->>'service_name')";
    private static final String CUST = "coalesce(new_row->>'customer_id', old_row->>'customer_id')";
    private static final String RLID = "coalesce(new_row->>'rate_limit_id', old_row->>'rate_limit_id')";

    private final DataSource dataSource;

    public AuditRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * List audit entries for a service, newest first, keyset-paginated on
     * {@code audit_id} descending. Optional filters: one tuple ({@code key}), one
     * {@code configId}, and a {@code since} lower bound on {@code changed_at}.
     */
    public Page<AuditRow> list(String serviceName, Optional<LimitKey> key, Optional<Long> configId,
                               Optional<Instant> since, int pageSize, String pageToken) {
        long cursor = PageToken.decodeLong(pageToken, Long.MAX_VALUE);
        StringBuilder sql = new StringBuilder("SELECT " + COLS + " FROM limit_config_audit"
                + " WHERE " + SVC + " = ? AND audit_id < ?");
        List<Object> params = new ArrayList<>();
        params.add(serviceName);
        params.add(cursor);
        configId.ifPresent(id -> {
            sql.append(" AND config_id = ?");
            params.add(id);
        });
        key.ifPresent(k -> {
            sql.append(" AND ").append(CUST).append(" = ? AND ").append(RLID).append(" = ?");
            params.add(k.getCustomerId());
            params.add(k.getRateLimitId());
        });
        since.ifPresent(ts -> {
            sql.append(" AND changed_at >= ?");
            params.add(Timestamp.from(ts));
        });
        sql.append(" ORDER BY audit_id DESC LIMIT ?");
        params.add(pageSize + 1);

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            try (ResultSet rs = ps.executeQuery()) {
                List<AuditRow> rows = new ArrayList<>();
                while (rs.next()) {
                    rows.add(map(rs));
                }
                if (rows.size() > pageSize) {
                    List<AuditRow> page = rows.subList(0, pageSize);
                    String next = PageToken.encodeLong(page.get(page.size() - 1).auditId());
                    return new Page<>(List.copyOf(page), next);
                }
                return new Page<>(List.copyOf(rows), "");
            }
        } catch (SQLException e) {
            throw SqlErrors.translate(e);
        }
    }

    private static AuditRow map(ResultSet rs) throws SQLException {
        Timestamp ts = rs.getTimestamp("changed_at");
        return new AuditRow(
                rs.getLong("audit_id"),
                rs.getLong("config_id"),
                rs.getString("operation"),
                rs.getString("old_row"),
                rs.getString("new_row"),
                rs.getString("changed_by"),
                ts == null ? null : ts.toInstant());
    }
}
