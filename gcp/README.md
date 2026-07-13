# GCP end-to-end demo — Regional Rate Limiter

Deploys the whole system to **Google Kubernetes Engine**, backed by **Cloud SQL
(PostgreSQL)** and **Memorystore (Redis)** on a **private network with no public
IPs**, and gives you a **local, automated e2e test suite** plus a manual
walkthrough. Everything here runs from your machine.

```
                 ┌─────────────── external L4 LoadBalancers ───────────────┐
   grpcurl ─────▶│ quotamgmt :8443 (gRPC)   quotaenforcer :8444 (gRPC)     │
   browser ─────▶│ quotaui :80 (HTTP, BFF+SPA)                             │
                 └──────────────────────────┬──────────────────────────────┘
                                             │  (in-cluster)
   GKE (regional, 3 zones)                   ▼
     quotamgmt   x3   ─────────────┐   quotaui x3 ──dials──▶ quotamgmt / quotaenforcer
     quotaenforcer x3→10 (HPA) ──┐ │
     quotaui     x3              │ │
                                 ▼ ▼
              ┌──────── private VPC (Private Service Access peering) ───────┐
              │  Cloud SQL Postgres (private IP)   Memorystore Redis (priv) │
              └────────────────────────────────────────────────────────────┘
```

## What maps to your requirements

| Requirement | Where |
|---|---|
| Cloud SQL (Postgres) + Memorystore (Redis) | `terraform/cloudsql.tf`, `terraform/redis.tf` |
| K8s runs quotamgmt / quotaenforcer / quotaui | `k8s/30-…`, `k8s/40-…`, `k8s/50-…` |
| **≥3 replicas** each | `replicas: 3` in each deployment (+ zone spread) |
| quotaenforcer **scales to 10** | `k8s/40-quotaenforcer.yaml` HPA `minReplicas: 3 / maxReplicas: 10` |
| Each of the 3 exposed via **external LB** | `Service type: LoadBalancer` (L4) in each manifest |
| Redis + Cloud SQL **private, no public IP** | `ipv4_enabled=false` (SQL), `PRIVATE_SERVICE_ACCESS` (Redis), `terraform/network.tf` |
| **e2e automated tests, local** | `e2e/` (pytest) + `e2e/run.sh` |
| **manuals for testing** | `MANUAL_TESTING.md` |

## Layout

```
gcp/
  terraform/     VPC + Private Service Access, GKE, Cloud SQL (private),
                 Memorystore (private), Artifact Registry
  k8s/           namespace, config/secret, db-init Job, 3 deployments + LB
                 services, enforcer HPA (envsubst placeholders ${...})
  scripts/       preflight / provision / build-push / deploy / seed /
                 endpoints / loadgen / teardown  (all run locally)
  e2e/           pytest suite that drives the deployed LBs + run.sh
  MANUAL_TESTING.md
```
The three service **Dockerfiles** live at each component root
(`../quotamgmt/Dockerfile`, `../quotaenforcer/Dockerfile`, `../quotaui/Dockerfile`);
their build context is the repo root (they compile the shared `../proto`).

## Prerequisites (local)

- `gcloud` (authenticated), `kubectl`, `terraform`, `docker`, `grpcurl`,
  `envsubst` (from gettext), `python3`. Run `scripts/00-preflight.sh` to check.
- A GCP **project** with **billing enabled** and rights to create GKE / Cloud SQL /
  Memorystore / VPC / Artifact Registry.

### Credentials

```sh
gcloud auth login
gcloud auth application-default login     # Terraform uses ADC
gcloud config set project <YOUR_PROJECT>
```

Then set the project for Terraform:

```sh
cd gcp/terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: set project_id (and optionally region/prefix)
```

## Deploy

One command (preflight → provision → build/push → deploy → seed):

```sh
cd gcp/scripts
./up.sh
```

…or step by step (each script is independent and re-runnable):

```sh
./00-preflight.sh      # verify tools + auth
./10-provision.sh      # terraform apply; ~15–20 min (Cloud SQL is the long pole)
./20-build-push.sh     # build 3 images, push to Artifact Registry
./30-deploy.sh         # render manifests from TF outputs, load schema, apply
./40-seed.sh           # demo service + limits (search-svc)
./50-endpoints.sh      # print the external IPs + export lines
```

`30-deploy.sh` fills the `${...}` placeholders in `k8s/` from Terraform outputs
(private DB IP, DB password, Redis host/AUTH) via `envsubst`, publishes
`../schema/postgres.sql` as a ConfigMap, and runs an in-cluster **db-init Job**
(the DB is private, so the schema can't be loaded from your laptop).

## Test

### Automated (local)

```sh
cd gcp/e2e
./run.sh               # auto-discovers LB IPs via kubectl, then runs pytest
```

Covers: reachability + fail-open default, control-plane CRUD + resolution, the
full check/charge/refund/usage lifecycle (incl. negative overshoot), `*`-default
vs exact override, new-limit propagation (~5s), the quotaui BFF (auth / RBAC /
live usage), and — via `-m ha` — that each service has ≥3 ready replicas and the
enforcer HPA is 3→10. HPA scale-up under load is `-m slow` (opt-in).

```sh
./run.sh -m ha         # HA/replica + HPA-config assertions (needs kubectl)
./run.sh -m slow       # drive load, assert enforcer scales past 3 (env-dependent)
./run.sh -k enforcement
```

If you'd rather set endpoints explicitly, use the `export` lines that
`scripts/50-endpoints.sh` prints.

### Manual / guided playground

Fastest hands-on tour of the live deployment — a narrated, step-by-step script
that auto-discovers the endpoints and pauses between steps:

```sh
cd gcp/scripts
./demo.sh              # press Enter between steps (DEMO_YES=1 to run straight through)
```

See **[MANUAL_TESTING.md](MANUAL_TESTING.md)** for the same steps done by hand —
grpcurl against both gRPC LBs, the quotaui console in a browser, and a load-driven
HPA demo (`scripts/loadgen.sh`).

## Tear down

The deployed resources (GKE, Cloud SQL, Memorystore, load balancers) **bill
continuously**, so tear the demo down when you're done:

```sh
cd gcp/scripts
./down.sh              # one command: delete namespace (frees LBs) → terraform destroy
```

`down.sh` is the symmetric counterpart to `up.sh` — a thin wrapper around
[`90-teardown.sh`](90-teardown.sh) (still runnable directly). It deletes the
Kubernetes namespace **first** so GCP releases the external LoadBalancer
forwarding rules before Terraform destroys the VPC, then runs `terraform destroy`.
Args pass through to the underlying script.

## Notes / tradeoffs

- **L4 passthrough LBs** for the gRPC services (plaintext HTTP/2) keep the demo
  simple — `grpcurl -plaintext` just works. For production you'd add TLS and,
  for the UI, an HTTPS LB with a managed cert.
- **Auth** uses quotamgmt's dev platform-admin token (`QUOTAMGMT_DEV_TOKEN`,
  default `quota-demo-admin-token`, overridable) and the BFF's dev authenticator —
  the same seams the repo already documents. Swap in SSO/mTLS for real use.
- **Config propagation** to the data plane is TTL-bound (~5s new, ~30s updates) by
  design — see `quotaenforcer/README.md`. The e2e propagation test targets the ~5s
  new-limit path.
- Only **Cloud SQL and Redis** are required to lack public IPs; GKE nodes keep
  default egress (Cloud NAT is provisioned regardless).
