package com.anthropic.quotamgmt.store;

import com.anthropic.quotamgmt.db.SqlErrors;
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
import java.util.Set;

/**
 * Data access for the {@code service} registry (design/quotamgmt.md §3.7). A
 * {@code limit_config.service_name} FKs here, so a service must be registered
 * before any limit references it. This table has no audit trigger (registration
 * is not a limit mutation), so writes do not set {@code app.actor}.
 */
public final class ServiceRepository {

    private final DataSource dataSource;

    public ServiceRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** Insert a service; {@code ALREADY_EXISTS} if the name is taken. */
    public ServiceRow register(ServiceRow service) {
        String sql = "INSERT INTO service (service_name, display_name, owner)"
                + " VALUES (?, ?, ?) RETURNING service_name, display_name, owner";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, service.serviceName());
            ps.setString(2, service.displayName());
            ps.setString(3, service.owner());
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return map(rs);
            }
        } catch (SQLException e) {
            AppException translated = SqlErrors.translate(e);
            if (translated.code() == Status.Code.ALREADY_EXISTS) {
                throw AppException.of(Status.Code.ALREADY_EXISTS,
                        "service '" + service.serviceName() + "' is already registered", e);
            }
            throw translated;
        }
    }

    public Optional<ServiceRow> get(String serviceName) {
        String sql = "SELECT service_name, display_name, owner FROM service WHERE service_name = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, serviceName);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? Optional.of(map(rs)) : Optional.empty();
            }
        } catch (SQLException e) {
            throw SqlErrors.translate(e);
        }
    }

    /**
     * Keyset-paginated list ordered by {@code service_name}. Scoped to the
     * caller's viewable services unless {@code isAdmin} (design §7.2 tenant
     * scoping); an admin with an empty allow-set still sees everything.
     */
    public Page<ServiceRow> list(int pageSize, String pageToken, Set<String> allowed, boolean isAdmin) {
        String cursor = PageToken.decode(pageToken);
        StringBuilder sql = new StringBuilder(
                "SELECT service_name, display_name, owner FROM service WHERE service_name > ?");
        List<Object> params = new ArrayList<>();
        params.add(cursor == null ? "" : cursor);
        if (!isAdmin) {
            sql.append(" AND service_name = ANY (?)");
            params.add(allowed.toArray(new String[0]));
        }
        sql.append(" ORDER BY service_name LIMIT ?");
        params.add(pageSize + 1);

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            bind(conn, ps, params);
            try (ResultSet rs = ps.executeQuery()) {
                List<ServiceRow> rows = new ArrayList<>();
                while (rs.next()) {
                    rows.add(map(rs));
                }
                if (rows.size() > pageSize) {
                    List<ServiceRow> page = rows.subList(0, pageSize);
                    String next = PageToken.encode(page.get(page.size() - 1).serviceName());
                    return new Page<>(List.copyOf(page), next);
                }
                return new Page<>(List.copyOf(rows), "");
            }
        } catch (SQLException e) {
            throw SqlErrors.translate(e);
        }
    }

    private static void bind(Connection conn, PreparedStatement ps, List<Object> params)
            throws SQLException {
        for (int i = 0; i < params.size(); i++) {
            Object p = params.get(i);
            if (p instanceof String[] arr) {
                ps.setArray(i + 1, conn.createArrayOf("text", arr));
            } else {
                ps.setObject(i + 1, p);
            }
        }
    }

    private static ServiceRow map(ResultSet rs) throws SQLException {
        return new ServiceRow(
                rs.getString("service_name"),
                rs.getString("display_name"),
                rs.getString("owner"));
    }
}
