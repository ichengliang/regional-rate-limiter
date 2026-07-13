// Session context: loads the current session from the BFF, exposes login/logout,
// and a bound `can()` for RBAC-aware UX (design §4.3 — UX only, never trusted).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setCsrf } from "./api";
import { canDo, type Capability } from "./util/rbac";
import type { SessionInfo } from "./types";

interface SessionCtx {
  session: SessionInfo | null;
  loading: boolean;
  login: (user: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (cap: Capability, service?: string) => boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((s: SessionInfo | null) => {
    setSession(s);
    setCsrf(s?.csrf_token ?? "");
  }, []);

  useEffect(() => {
    api
      .session()
      .then(apply)
      .catch(() => apply(null))
      .finally(() => setLoading(false));
  }, [apply]);

  const login = useCallback(
    async (user: string) => {
      apply(await api.login(user));
    },
    [apply],
  );

  const logout = useCallback(async () => {
    await api.logout();
    apply(null);
  }, [apply]);

  const can = useCallback(
    (cap: Capability, service?: string) => (session ? canDo(session.grants, cap, service) : false),
    [session],
  );

  return <Ctx.Provider value={{ session, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession must be used within SessionProvider");
  return c;
}
