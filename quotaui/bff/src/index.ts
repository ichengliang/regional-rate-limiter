import express from "express";
// gRPC client stubs are constructed here so the scaffold fails fast if the protos
// can't be loaded. They are not yet used by any route.
import "./grpc.js";

const app = express();
app.use(express.json());

// Health check — the one real route in this scaffold.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// TODO: mount the config / services / audit / live-usage / manual-op routes under /api,
// proxying to quotamgmt (quotamgmtClient) and quotaenforcer (quotaenforcerClient) with
// RBAC + identity->app.actor enforcement, per design/quotaui.md §4 and §5. Not yet implemented.

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`quotaui BFF listening on http://localhost:${port}`);
});
