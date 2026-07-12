// Mock dev server: starts the in-memory quotamgmt + quotaenforcer fakes, seeds
// sample data, and runs the real BFF against them. Lets you click through the
// whole UI with no Java/Rust backends. Run: `npm run dev:mock`.
import { createBackends } from "../src/grpc.js";
import { makeDeps } from "../src/deps.js";
import { GrantStore } from "../src/session.js";
import { createApp } from "../src/app.js";
import type { User } from "../src/rbac.js";
import { startBackends } from "./mocks.js";

const DEV_USERS: User[] = [
  { id: "alice", email: "alice@anthropic.com", grants: [{ role: "operator" }] },
  { id: "carol", email: "carol@anthropic.com", grants: [{ role: "operator" }] },
  { id: "bob", email: "bob@anthropic.com", grants: [{ role: "service-editor", service: "search-svc" }] },
  { id: "vic", email: "vic@anthropic.com", grants: [{ role: "viewer" }] },
  { id: "admin", email: "admin@anthropic.com", grants: [{ role: "admin" }] },
];

const h = await startBackends();

// --- seed sample data so every screen has something to show ---
h.mgmt.services.set("search-svc", { service_name: "search-svc", display_name: "Search", owner: "search-team" });
h.mgmt.services.set("payments-svc", { service_name: "payments-svc", display_name: "Payments", owner: "payments-team" });

const seedLimits: Array<[string, string, string, number, string]> = [
  ["search-svc", "*", "default", 500, "MINUTE"],
  ["search-svc", "cust_42", "default", 1000, "MINUTE"],
  ["search-svc", "*", "export", 5, "DAY"],
  ["search-svc", "cust_99", "export", 10, "DAY"],
  ["payments-svc", "*", "charge", 100, "MINUTE"],
];
let cid = 1;
for (const [service_name, customer_id, rate_limit_id, limit_value, time_unit] of seedLimits) {
  const key = { service_name, customer_id, rate_limit_id };
  h.mgmt.limits.set(`${service_name}|${customer_id}|${rate_limit_id}`, {
    config_id: cid,
    key,
    limit_value,
    time_unit,
  });
  h.mgmt.audit.push({
    audit_id: cid,
    config_id: cid,
    operation: "INSERT",
    old_row: null,
    new_row: { ...key, limit_value, time_unit },
    changed_by: "seed@anthropic.com",
    changed_at: { seconds: Math.floor(Date.now() / 1000), nanos: 0 },
  });
  cid++;
}
// A couple of live counters, including one that's over quota (bounded overshoot).
h.enforcer.seed({ service_name: "search-svc", customer_id: "cust_42", rate_limit_id: "default" }, { consumed: 1003, limit: 1000 });
h.enforcer.seed({ service_name: "search-svc", customer_id: "cust_99", rate_limit_id: "export" }, { consumed: 3, limit: 10 });

const deps = makeDeps({
  backends: createBackends({ quotamgmtAddr: h.quotamgmtAddr, quotaenforcerAddr: h.quotaenforcerAddr }),
  grants: new GrantStore(DEV_USERS),
});

const app = createApp(deps);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`\n  quotaui BFF (MOCK backends) → http://localhost:${port}`);
  console.log(`  mock quotamgmt:     ${h.quotamgmtAddr}`);
  console.log(`  mock quotaenforcer: ${h.quotaenforcerAddr}`);
  console.log(`  dev users: alice (operator), bob (search-svc editor), vic (viewer), admin`);
  console.log(`  seeded services: search-svc, payments-svc\n`);
});
