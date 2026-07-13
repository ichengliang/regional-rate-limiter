# quotamgmt — control plane

Java 21 / Gradle gRPC service implementing `quotamgmt.v1.LimitAdmin` (see
[`../proto/quotamgmt/v1/limit_admin.proto`](../proto/quotamgmt/v1/limit_admin.proto)
and [`../design/quotamgmt.md`](../design/quotamgmt.md)). It owns rate-limit
**configuration** and its **audit trail** in Postgres and exposes the CRUD +
read APIs the UI and programmatic clients use. It is never in the request hot
path.

## What's implemented

- **Limit CRUD** — `CreateLimit`, `UpdateLimit` (with `create_if_absent` upsert),
  `DeleteLimit` (with `allow_missing`), `GetLimit` (exact + `resolve` = exact-then-
  default, §4.2), `ListLimits` (keyset pagination, service-scoped).
- **Service registry** — `RegisterService`, `GetService`, `ListServices`.
- **Audit read** — `ListAuditEntries` (newest-first, service/config/tuple/since
  filters), reading `old_row`/`new_row` JSONB as `google.protobuf.Struct`.
- **Audited writes** — every mutation runs in one transaction with
  `SET LOCAL app.actor` (via `set_config(..., true)`); the DB trigger is the sole
  audit writer, so an unattributed change is impossible (§4.4).
- **Validation** — the §3.8 rules, each mapped to a Postgres constraint, with a
  machine-readable `field` on `INVALID_ARGUMENT` (returned as a response trailer).
- **AuthN/Z** — a bearer-token `AuthInterceptor` pins the caller `Principal` into
  the gRPC context; per-`service_name` RBAC (editor / viewer / platform-admin, §7).
- **Error mapping** — the §3.10 code table (`ALREADY_EXISTS`, `NOT_FOUND`,
  `FAILED_PRECONDITION`, `PERMISSION_DENIED`, `UNAVAILABLE`, `ABORTED`, …).

Code layout (`src/main/java/com/anthropic/quotamgmt`): `config/` (env config),
`db/` (pooled DataSource, SQL error translation), `store/` (JDBC repositories +
row records), `validation/`, `paging/` (keyset cursors), `auth/`, `service/`
(proto mappers), `error/`, plus `LimitAdminService` (orchestration) and `Main`.

**Not implemented** (operational, not API surface): the data-plane change-feed
(watermark poll / `LISTEN/NOTIFY` relay / snapshot bootstrap, §5 — consumed by
`quotaenforcer`, not exposed as RPCs), admin-tier rate limiting (§7.4), and the
read-replica routing / multi-region topology (§9), which are deployment concerns.

## Build & run

The Gradle wrapper is committed; Java 21 is required.

```sh
./gradlew build          # compiles protos from ../proto, Java sources, and runs tests
./gradlew run            # starts the gRPC server
./gradlew installDist && ./build/install/quotamgmt/bin/quotamgmt   # or the built dist
```

## Configuration

Postgres connection uses the conventional `PG*` env vars (JVM `-Dquotamgmt.db.*`
overrides win), matching `psql`:

| Setting | Env | Default |
|---------|-----|---------|
| host | `PGHOST` | `localhost` |
| port | `PGPORT` | `5432` |
| database | `PGDATABASE` | `quota` |
| user | `PGUSER` | `postgres` |
| password | `PGPASSWORD` | `postgres` |
| pool size | `QUOTAMGMT_DB_POOL` | `8` |
| gRPC port | `QUOTAMGMT_PORT` / `-Dquotamgmt.port` | `8443` |

In production use the dedicated `quotamanager` role (design §9.1); the `postgres`
superuser is fine for local dev.

**Auth bootstrap.** A real deployment plugs an SSO/mTLS-backed `Authorizer`
(§7.1). For local use, seed a single dev platform-admin token:

```sh
./gradlew run -Dquotamgmt.auth.devAdminToken=dev123
# then call with:  authorization: Bearer dev123
```

Without a configured principal, every call is `UNAUTHENTICATED` (no anonymous RPCs).

## Testing

```sh
./gradlew test
```

- **Unit tests** (no DB): validation rules, keyset page tokens, RBAC grant logic.
- **Integration tests** (`*IT`, real Postgres): the audited write path, the
  trigger's raise-if-unset guarantee, exact-then-default resolution, and the full
  gRPC surface end-to-end (worked scenario §3.11, error/RBAC matrix §3.10/§7).

Integration tests provision an isolated `quota_test` database (recreated from
`../schema/postgres.sql`) so the developer's `quota` database is never touched.
They read the same `PG*` env vars; if Postgres is unreachable the IT classes skip
(via JUnit assumptions) rather than fail. Load the credentials from the project
`.env` (repo root) — the loop handles the `&` in the password that a plain
`source` would not:

```sh
while IFS='=' read -r k v; do export "$k=$v"; done < <(grep -E '^PG' ../.env)
./gradlew test
```
