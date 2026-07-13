# Manual testing — GCP deployment

Hands-on verification of the deployed stack. Assumes `scripts/up.sh` (or the
numbered scripts) succeeded and `scripts/40-seed.sh` seeded `search-svc`.

## Guided playground (one command)

The fastest way to play with the live deployment is the narrated walkthrough
script — it auto-discovers the endpoints, prints each command before running it,
and pauses between steps:

```sh
cd gcp/scripts
./demo.sh              # press Enter between steps
DEMO_YES=1 ./demo.sh   # run straight through, no pauses
```

It covers the whole story end-to-end: list services → create a 5/min limit →
watch it propagate → check/charge to exhaustion (**denied**) → usage → refund →
the quotaui admin console → HA (3 replicas + enforcer HPA 3→10).

The rest of this doc is the same steps done **by hand**, for when you want to
poke at individual pieces.

## 0. Endpoints

```sh
cd gcp/scripts && ./50-endpoints.sh
# copy the export block it prints:
export QUOTAMGMT_ADDR=<qm-ip>:8443
export QUOTAENFORCER_ADDR=<qe-ip>:8444
export QUOTAUI_URL=http://<ui-ip>
export QUOTAMGMT_TOKEN=quota-demo-admin-token   # or your override
```

Prereqs: `grpcurl`, `curl`, `kubectl`. Both gRPC services expose **server
reflection**, so grpcurl needs no local `.proto` files.

## 1. Control plane (quotamgmt) — config CRUD

```sh
AUTH="authorization: Bearer $QUOTAMGMT_TOKEN"

# List services (proves authN + a live pod behind the LB)
grpcurl -plaintext -H "$AUTH" $QUOTAMGMT_ADDR quotamgmt.v1.LimitAdmin/ListServices

# Create a limit: 20 req/min default for a new service
grpcurl -plaintext -H "$AUTH" -d '{"service":{"service_name":"manual-svc","display_name":"Manual","owner":"me"}}' \
  $QUOTAMGMT_ADDR quotamgmt.v1.LimitAdmin/RegisterService
grpcurl -plaintext -H "$AUTH" -d '{"key":{"service_name":"manual-svc","customer_id":"*","rate_limit_id":"rpm"},"limit_value":20,"time_unit":"MINUTE"}' \
  $QUOTAMGMT_ADDR quotamgmt.v1.LimitAdmin/CreateLimit

# Resolve (exact-then-default): an unlisted customer inherits the '*' cap
grpcurl -plaintext -H "$AUTH" -d '{"key":{"service_name":"manual-svc","customer_id":"anyone","rate_limit_id":"rpm"},"resolve":true}' \
  $QUOTAMGMT_ADDR quotamgmt.v1.LimitAdmin/GetLimit
```

Expected: `ListServices` returns `search-svc` (+ any you add); `GetLimit resolve`
returns `limit_value: 20`.

> Note: grpcurl omits proto3 zero/false fields — a missing `allowed` means
> `false`, `{}` means all-zero. This is normal.

## 2. Data plane (quotaenforcer) — enforce

`search-svc / cust_42 / requests_per_min` was seeded at **5/min** (easy to
exhaust).

```sh
QE=$QUOTAENFORCER_ADDR
K='{"service_name":"search-svc","customer_id":"cust_42","rate_limit_id":"requests_per_min"}'

# Check (no consume): allowed=true, limit=5
grpcurl -plaintext -d "{\"key\":$K,\"cost\":1}" $QE quotaenforcer.v1.RateLimiter/CheckQuota

# Charge 5 → remaining 0
grpcurl -plaintext -d "{\"key\":$K,\"cost\":5}" $QE quotaenforcer.v1.RateLimiter/Charge

# Check again → allowed omitted (=false), remaining 0  ← DENIED
grpcurl -plaintext -d "{\"key\":$K,\"cost\":1}" $QE quotaenforcer.v1.RateLimiter/CheckQuota

# Usage → consumed 5, remaining 0
grpcurl -plaintext -d "{\"key\":$K}" $QE quotaenforcer.v1.RateLimiter/GetUsage

# Refund 5 → remaining 5, allowed again
grpcurl -plaintext -d "{\"key\":$K,\"amount\":5}" $QE quotaenforcer.v1.RateLimiter/Refund
```

**Unconfigured = allow (fail-open default):**

```sh
grpcurl -plaintext -d '{"key":{"service_name":"nope","customer_id":"x","rate_limit_id":"y"},"cost":1}' \
  $QE quotaenforcer.v1.RateLimiter/CheckQuota      # allowed=true, limit=0 (unlimited)
```

## 3. New-limit propagation (~5s)

```sh
K2='{"service_name":"manual-svc","customer_id":"c9","rate_limit_id":"rpm"}'
grpcurl -plaintext -d "{\"key\":$K2}" $QE quotaenforcer.v1.RateLimiter/CheckQuota   # limit 20 (from step 1)
# Now change it and watch it flip within ~30s (update TTL) — new keys flip in ~5s.
```

## 4. quotaui admin console (browser + curl)

Open **`$QUOTAUI_URL`** in a browser — the BFF serves the SPA. Or drive the API:

```sh
# Dev login as an operator; keep the session cookie
curl -s -c cj -X POST $QUOTAUI_URL/api/auth/login \
  -H 'content-type: application/json' -d '{"user":"alice"}'
CSRF=$(curl -s -b cj $QUOTAUI_URL/api/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf_token"])')

# Read config + live usage through the UI tier
curl -s -b cj "$QUOTAUI_URL/api/limits?service_name=search-svc"
curl -s -b cj "$QUOTAUI_URL/api/usage?service_name=search-svc&customer_id=cust_42&rate_limit_id=requests_per_min"
```

**RBAC (viewer cannot write):**

```sh
curl -s -c vj -X POST $QUOTAUI_URL/api/auth/login -H 'content-type: application/json' -d '{"user":"vic"}' >/dev/null
VCSRF=$(curl -s -b vj $QUOTAUI_URL/api/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf_token"])')
curl -s -o /dev/null -w '%{http_code}\n' -b vj -X POST $QUOTAUI_URL/api/limits \
  -H "x-csrf-token: $VCSRF" -H 'content-type: application/json' \
  -d '{"service_name":"search-svc","customer_id":"*","rate_limit_id":"rpm","limit_value":1,"time_unit":"MINUTE"}'
# → 403
```

Dev users: `alice` (operator), `bob` (service-editor of search-svc), `vic`
(viewer), `admin`.

## 5. High availability — 3 replicas per service

```sh
kubectl -n quota get deploy
# READY should show 3/3 for quotamgmt, quotaenforcer, quotaui
kubectl -n quota get pods -o wide   # spread across zones/nodes
```

Kill a pod and watch it self-heal without downtime:

```sh
kubectl -n quota delete pod -l app=quotaenforcer --field-selector status.phase=Running | head -1
# re-run a CheckQuota from step 2 — still served (other 2 replicas + LB)
```

## 6. Enforcer autoscaling 3 → 10 (HPA under load)

```sh
kubectl -n quota get hpa quotaenforcer         # MINPODS 3, MAXPODS 10
# In one terminal, watch:
watch kubectl -n quota get hpa,pods -l app=quotaenforcer
# In another, generate load:
cd gcp/scripts && WORKERS=128 DURATION=300 ./loadgen.sh
```

As CPU passes the 60% target the HPA raises replica count (up to 10); it scales
back down after load stops. The automated equivalent is `e2e/run.sh -m slow`.

## 7. Private networking check (no public IPs)

```sh
cd gcp/terraform
terraform output db_private_ip           # a 10.x address; there is NO public IP
gcloud sql instances describe $(terraform output -raw cluster_name | sed 's/-gke/-pg/') \
  --format='value(ipAddresses[].type)'   # PRIVATE only
gcloud redis instances describe $(terraform output -raw cluster_name | sed 's/-gke/-redis/') \
  --region "$(terraform output -raw region)" --format='value(host,connectMode)'  # PRIVATE_SERVICE_ACCESS
```

Both back ends are reachable **only** from inside the VPC (that's why the schema
load in step 3 of deploy runs as an in-cluster Job, not from your laptop).
