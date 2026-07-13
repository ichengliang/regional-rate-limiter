// App shell: login gate + tab navigation (design §6). RBAC-aware tabs are shown
// for everyone (all reads are permitted); write affordances inside each page are
// gated by `can()` (§4.3, UX only).
import { useState } from "react";
import { useSession } from "./session";
import { LimitsBrowser } from "./pages/LimitsBrowser";
import { LiveUsage } from "./pages/LiveUsage";
import { AuditBrowser } from "./pages/AuditBrowser";
import { Services } from "./pages/Services";
import { Reviews } from "./pages/Reviews";

type Tab = "limits" | "services" | "usage" | "audit" | "reviews";

const TABS: { id: Tab; label: string }[] = [
  { id: "limits", label: "Limits" },
  { id: "services", label: "Services" },
  { id: "usage", label: "Live Usage" },
  { id: "audit", label: "Audit" },
  { id: "reviews", label: "Reviews" },
];

export default function App() {
  const { session, loading, login, logout, can } = useSession();
  const [tab, setTab] = useState<Tab>("limits");
  const [devUser, setDevUser] = useState("alice");

  if (loading) return <p className="center">loading…</p>;

  if (!session) {
    return (
      <main className="login">
        <h1>quotaui</h1>
        <p className="muted">Internal admin console — sign in.</p>
        <p className="muted">
          Dev auth (stands in for OIDC/SSO, design §4.1). Seeded users:
          <code>alice</code> (operator), <code>bob</code> (search-svc editor),
          <code>vic</code> (viewer), <code>admin</code>.
        </p>
        <div className="filters">
          <input value={devUser} onChange={(e) => setDevUser(e.target.value)} aria-label="dev user" />
          <button className="primary" onClick={() => void login(devUser)}>
            Sign in
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <strong>quotaui</strong>
        <nav>
          {TABS.filter((t) => t.id !== "reviews" || can("review:approve")).map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab active" : "tab"}
              aria-current={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="who">
          {session.user.email}
          <button onClick={() => void logout()}>sign out</button>
        </span>
      </header>

      {tab === "limits" && <LimitsBrowser />}
      {tab === "services" && <Services />}
      {tab === "usage" && <LiveUsage />}
      {tab === "audit" && <AuditBrowser />}
      {tab === "reviews" && <Reviews />}
    </main>
  );
}
