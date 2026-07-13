// BFF entrypoint: build backends from env, seed dev grants, create the app, listen.
import { createBackends } from "./grpc.js";
import { makeDeps } from "./deps.js";
import { GrantStore } from "./session.js";
import { createApp } from "./app.js";
import type { User } from "./rbac.js";

// Dev grant seed (AUTH_MODE=dev). In production these come from OIDC claims / the
// admin-managed grant store (design §4.2); this seed only exists so the dev login
// route has users to hand out. Override by editing or replacing the store.
const DEV_USERS: User[] = [
  { id: "alice", email: "alice@anthropic.com", grants: [{ role: "operator" }] },
  { id: "bob", email: "bob@anthropic.com", grants: [{ role: "service-editor", service: "search-svc" }] },
  { id: "vic", email: "vic@anthropic.com", grants: [{ role: "viewer" }] },
  { id: "admin", email: "admin@anthropic.com", grants: [{ role: "admin" }] },
];

const deps = makeDeps({
  backends: createBackends(),
  grants: new GrantStore(process.env.AUTH_MODE === "oidc" ? [] : DEV_USERS),
});

const app = createApp(deps);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`quotaui BFF listening on http://localhost:${port} (auth=${deps.authMode})`);
});
