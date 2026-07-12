# quotamgmt — Manual Verification Checklist

Manual test cases for the `quotamgmt.v1.LimitAdmin` gRPC API, exercised with
`grpcurl` against a running server. Covers the API surface, validation (§3.8),
error codes (§3.10), RBAC (§7), resolution (§4.2), and the audit trail (§3.9).

## Prerequisites

### Infrastructure

| Requirement | Needed by quotamgmt? | Details |
|-------------|----------------------|---------|
| **Java 21** | Yes | Build/run the service (`java -version`). |
| **PostgreSQL** | **Yes — required** | Source of truth for config + audit. See connection settings below. |
| **Redis** | **No** | Redis is the data-plane counter store owned by `quotaenforcer`; `quotamgmt` never touches it (design §1.2). It is *not* needed for anything in this checklist. |
| **grpcurl** | For manual testing only | gRPC client used by the commands below. |

### PostgreSQL config via `.env`

Postgres connection settings come from the project's **`.env`** file at the repo
root (`../.env` from the `quotamgmt/` directory). It is **gitignored** — it holds
local secrets and is never committed. Both `psql` and the service read the
conventional `PG*` variables, so the same file drives everything.

| Key | Value (local dev) | Used for |
|-----|-------------------|----------|
| `PGUSER` | `postgres` | Postgres role |
| `PGPASSWORD` | *(local secret — see `../.env`)* | password |
| `PGDATABASE` | `quota` | database |
| `GITHUB_PAT` | *(unrelated)* | GitHub token — not used here |

`PGHOST` and `PGPORT` aren't in `.env`; they default to `localhost` / `5432`.

Load the Postgres vars into your shell (run from `quotamgmt/`). The loop assigns
values literally, so the `&` in the password is handled correctly (a plain
`source ../.env` would not):

```bash
while IFS='=' read -r k v; do export "$k=$v"; done < <(grep -E '^PG' ../.env)
export PGHOST=${PGHOST:-localhost} PGPORT=${PGPORT:-5432}
```

The schema (`../schema/postgres.sql`) must already be applied to the `quota`
database. Verify (uses the vars just loaded — no inline password):

```bash
psql -c '\dt'   # expect: service, limit_config, limit_config_audit
```

> **Production note:** use the dedicated `quotamanager` role with the necessary
> grants rather than the `postgres` superuser (design §9.1). The integration
> tests use a separate `quota_test` database so they never touch `quota`.

### Start the server

From the `quotamgmt/` directory, with the `PG*` vars already loaded from `.env`
above (the service reads them directly):

```bash
export QUOTAMGMT_OPTS="-Dquotamgmt.auth.file=$(pwd)/dev-principals.json -Dquotamgmt.port=8443"
nohup ./build/install/quotamgmt/bin/quotamgmt > /tmp/quotamgmt-server.log 2>&1 &
# (build first if needed:  ./gradlew installDist)
```

The server has **gRPC server reflection** enabled, so `grpcurl` needs no `.proto`
files. Set up shell shortcuts:

```bash
GRPCURL=grpcurl                 # or the full path to the binary
Q="$GRPCURL -plaintext"
ADDR=localhost:8443
```

**Dev identities** (from `dev-principals.json`), passed as `authorization: Bearer <token>`:

| Token | Identity | Grants |
|-------|----------|--------|
| `admin-tok`   | `ops@corp`     | platform-admin (all services + RegisterService) |
| `alice-tok`   | `alice@corp`   | editor of `search-svc` |
| `bob-tok`     | `bob@corp`     | viewer of `search-svc` |
| `billing-tok` | `billing-team` | editor of `billing-svc` only |

Discovery (no token required):

```bash
$Q $ADDR list                          # services
$Q $ADDR list quotamgmt.v1.LimitAdmin  # methods
$Q $ADDR describe quotamgmt.v1.CreateLimitRequest
```

> **Note:** every write is applied to the real `quota` database. If `search-svc`
> already has limits, a colliding `CreateLimit` returns `AlreadyExists` — use
> `UpdateLimit` instead. To start clean: stop the server and (with the `PG*`
> vars loaded from `.env`)
> `psql -c "SET app.actor='reset'; DELETE FROM limit_config WHERE service_name='search-svc';"`.

---

## A. Auth & RBAC (§7)

- [ ] **1. No token → UNAUTHENTICATED**
  ```bash
  $Q -d '{"service_name":"search-svc"}' $ADDR quotamgmt.v1.LimitAdmin/ListLimits
  ```
  Expect: `Code: Unauthenticated`.

- [ ] **2. Unknown token → UNAUTHENTICATED**
  ```bash
  $Q -H "authorization: Bearer bogus" -d '{"service_name":"search-svc"}' $ADDR quotamgmt.v1.LimitAdmin/ListLimits
  ```
  Expect: `Code: Unauthenticated`, "unknown or expired token".

- [ ] **3. RegisterService as non-admin → PERMISSION_DENIED**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"service":{"service_name":"x-svc","display_name":"X","owner":"t"}}' $ADDR quotamgmt.v1.LimitAdmin/RegisterService
  ```
  Expect: `Code: PermissionDenied`, "is not a platform admin".

- [ ] **4. Viewer writing → PERMISSION_DENIED**
  ```bash
  $Q -H "authorization: Bearer bob-tok" -d '{"key":{"service_name":"search-svc","customer_id":"c1","rate_limit_id":"requests_per_min"},"limit_value":5,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: PermissionDenied`.

- [ ] **5. Editor of another service → PERMISSION_DENIED**
  ```bash
  $Q -H "authorization: Bearer billing-tok" -d '{"key":{"service_name":"search-svc","customer_id":"c1","rate_limit_id":"requests_per_min"},"limit_value":5,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: PermissionDenied`, "identity 'billing-team' is not an editor of service 'search-svc'".

## B. Validation (§3.8)

- [ ] **6. Negative limit → INVALID_ARGUMENT (field=limit_value)**
  ```bash
  $Q -v -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_7","rate_limit_id":"requests_per_min"},"limit_value":-5,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: InvalidArgument`, "limit_value must be >= 0". `-v` shows the `field: limit_value` trailer.

- [ ] **7. Missing time_unit → INVALID_ARGUMENT (field=time_unit)**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_7","rate_limit_id":"requests_per_min"},"limit_value":10}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: InvalidArgument`, "time_unit must be one of MINUTE, DAY, MONTH".

- [ ] **8. Malformed service_name → INVALID_ARGUMENT**
  ```bash
  $Q -H "authorization: Bearer admin-tok" -d '{"key":{"service_name":"Search_Svc","customer_id":"c1","rate_limit_id":"requests_per_min"},"limit_value":10,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: InvalidArgument`, "service_name must match …".

- [ ] **9. Malformed rate_limit_id → INVALID_ARGUMENT**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"c1","rate_limit_id":"Requests/Min"},"limit_value":10,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: InvalidArgument`, "rate_limit_id must match …".

## C. CRUD & resolution (§3.2–§3.5, §4.2)

- [ ] **10. Register the service (admin)**
  ```bash
  $Q -H "authorization: Bearer admin-tok" -d '{"service":{"service_name":"search-svc","display_name":"Search Service","owner":"search-team"}}' $ADDR quotamgmt.v1.LimitAdmin/RegisterService
  ```
  Expect: OK echoing the service (or `AlreadyExists` if already registered — fine).

- [ ] **11. Create default `*` = 1000/min (editor)**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"*","rate_limit_id":"requests_per_min"},"limit_value":1000,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: OK, `config_id` assigned. (If it already exists: `AlreadyExists` — use UpdateLimit.)

- [ ] **12. Create override cust_42 = 5000/min**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"limit_value":5000,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: OK.

- [ ] **13. Duplicate create → ALREADY_EXISTS** (re-run #12 verbatim)
  Expect: `Code: AlreadyExists`, "… already exists; use UpdateLimit".

- [ ] **14. Raise via UpdateLimit → same config_id**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"},"limit_value":6000,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/UpdateLimit
  ```
  Expect: OK, `limit_value:6000`, **same** `config_id` as #12.

- [ ] **15. Update a missing row → NOT_FOUND**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"ghost","rate_limit_id":"requests_per_min"},"limit_value":1,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/UpdateLimit
  ```
  Expect: `Code: NotFound`.

- [ ] **16. Upsert with create_if_absent** (re-run #15 with `"create_if_absent":true`)
  Expect: OK (created; audited as INSERT).

- [ ] **17. GetLimit resolve for an unconfigured customer → default**
  ```bash
  $Q -H "authorization: Bearer bob-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_99","rate_limit_id":"requests_per_min"},"resolve":true}' $ADDR quotamgmt.v1.LimitAdmin/GetLimit
  ```
  Expect: OK, `is_default:true`, value 1000, `customer_id:"*"`.

- [ ] **18. GetLimit exact on a missing row → NOT_FOUND** (same as #17 without `"resolve":true`)
  Expect: `Code: NotFound`.

- [ ] **19. ListLimits with paging**
  ```bash
  $Q -H "authorization: Bearer bob-tok" -d '{"service_name":"search-svc","page_size":1}' $ADDR quotamgmt.v1.LimitAdmin/ListLimits
  ```
  Expect: 1 limit + non-empty `next_page_token`; feed it back as `"page_token"` to get the next page.

- [ ] **20. Create for an unregistered service → FAILED_PRECONDITION**
  ```bash
  $Q -H "authorization: Bearer admin-tok" -d '{"key":{"service_name":"ghost-svc","customer_id":"c1","rate_limit_id":"requests_per_min"},"limit_value":10,"time_unit":"MINUTE"}' $ADDR quotamgmt.v1.LimitAdmin/CreateLimit
  ```
  Expect: `Code: FailedPrecondition`, "service 'ghost-svc' is not registered".

- [ ] **21. Delete override → falls back to default**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"}}' $ADDR quotamgmt.v1.LimitAdmin/DeleteLimit
  ```
  Expect: OK `{}`. Then a resolve for cust_42 (as in #17) returns the `*` default.

- [ ] **22. Delete missing → NOT_FOUND; with allow_missing → OK**
  ```bash
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"ghost2","rate_limit_id":"requests_per_min"}}' $ADDR quotamgmt.v1.LimitAdmin/DeleteLimit
  $Q -H "authorization: Bearer alice-tok" -d '{"key":{"service_name":"search-svc","customer_id":"ghost2","rate_limit_id":"requests_per_min"},"allow_missing":true}' $ADDR quotamgmt.v1.LimitAdmin/DeleteLimit
  ```
  Expect: first `NotFound`, second OK `{}`.

## D. Service registry (§3.7)

- [ ] **23. GetService (viewer)**
  ```bash
  $Q -H "authorization: Bearer bob-tok" -d '{"service_name":"search-svc"}' $ADDR quotamgmt.v1.LimitAdmin/GetService
  ```
  Expect: OK with display_name/owner.

- [ ] **24. ListServices is tenant-scoped**
  ```bash
  $Q -H "authorization: Bearer bob-tok"   -d '{}' $ADDR quotamgmt.v1.LimitAdmin/ListServices   # only search-svc
  $Q -H "authorization: Bearer admin-tok" -d '{}' $ADDR quotamgmt.v1.LimitAdmin/ListServices   # all services
  ```

## E. Audit trail (§3.9)

- [ ] **25. History for one config_id — newest first, with before/after**
  ```bash
  # find the config_id first:
  $Q -H "authorization: Bearer bob-tok" -d '{"key":{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"}}' $ADDR quotamgmt.v1.LimitAdmin/GetLimit
  # then (substitute <ID>):
  $Q -H "authorization: Bearer bob-tok" -d '{"service_name":"search-svc","config_id":<ID>}' $ADDR quotamgmt.v1.LimitAdmin/ListAuditEntries
  ```
  Expect: entries newest-first (`UPDATE` then `INSERT`, plus `DELETE` if you ran #21), each with
  `changed_by` = the acting identity (`alice@corp`), and `old_row`/`new_row` showing the value change.

- [ ] **26. Service-wide audit feed**
  ```bash
  $Q -H "authorization: Bearer bob-tok" -d '{"service_name":"search-svc","page_size":20}' $ADDR quotamgmt.v1.LimitAdmin/ListAuditEntries
  ```
  Expect: all recent changes for the service, attributed to the identity that made each one.

- [ ] **27. Actor attribution is enforced by the DB** (optional, direct SQL)
  ```bash
  psql -c "SELECT operation, changed_by, changed_at FROM limit_config_audit ORDER BY audit_id DESC LIMIT 10;"
  ```
  Expect: every mutation has a non-null `changed_by` — the trigger rejects unattributed writes (§4.4).

---

**Reading errors:** `grpcurl` prints `Code: … / Message: …`. Add `-v` to see response
trailers (e.g. the `field` on validation errors). The automated equivalents of these
cases live in `src/test/java/com/anthropic/quotamgmt/it/LimitAdminServiceIT.java`.
