// Live Usage Viewer (§2.4) + Manual Operations (§2.5, refund/reset).
import { useState } from "react";
import { api, isPending } from "../api";
import { useSession } from "../session";
import { ErrorText, Field } from "../components";
import { windowId } from "../util/windowId";
import type { UsageView } from "../types";

export function LiveUsage() {
  const { can } = useSession();
  const [service, setService] = useState("");
  const [customer, setCustomer] = useState("");
  const [rlid, setRlid] = useState("");
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const key = { service_name: service, customer_id: customer, rate_limit_id: rlid };

  const lookup = async () => {
    setError(null);
    setNotice(null);
    try {
      setUsage(await api.getUsage(key));
    } catch (e) {
      setError(e);
      setUsage(null);
    }
  };

  const doRefund = async () => {
    const amountStr = window.prompt("Refund amount:");
    if (!amountStr) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.refund({ ...key, amount: Number(amountStr) });
      if (isPending(res)) setNotice(`Refund requires two-person review: ${res.review.reason}`);
      else await lookup();
    } catch (e) {
      setError(e);
    }
  };

  const doReset = async () => {
    if (!window.confirm(`Reset window for ${customer}? Returns remaining to full.`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.reset(key);
      if (isPending(res)) setNotice(`Reset requires two-person review: ${res.review.reason}`);
      else setUsage(res as UsageView);
    } catch (e) {
      setError(e);
    }
  };

  const overQuota = usage != null && usage.configured && usage.remaining < 0;

  return (
    <section>
      <h2>Live usage</h2>
      <p className="muted">source: quotaenforcer read API → Redis (never cached, §2.4)</p>
      <div className="filters">
        <Field label="Service">
          <input value={service} onChange={(e) => setService(e.target.value)} />
        </Field>
        <Field label="Customer">
          <input value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </Field>
        <Field label="Rate limit id">
          <input value={rlid} onChange={(e) => setRlid(e.target.value)} />
        </Field>
        <button onClick={lookup}>Lookup</button>
      </div>

      <ErrorText error={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {usage && (
        <div className="panel">
          {!usage.configured && (
            <p className="warn">unconfigured → allow (fail-open, parent §9)</p>
          )}
          <dl className="kv">
            <dt>limit</dt>
            <dd>{usage.limit ?? "—"}</dd>
            <dt>consumed</dt>
            <dd>{usage.consumed}</dd>
            <dt>remaining</dt>
            <dd>
              {usage.remaining}
              {overQuota && <span className="warn"> ⚠ over quota (bounded overshoot, §6.4)</span>}
            </dd>
            <dt>reset_at</dt>
            <dd>{usage.reset_at ?? "—"}</dd>
            <dt>window (computed)</dt>
            <dd>
              {/* window_id is display-only; unit comes from config, minute shown as example */}
              minute: {windowId("MINUTE", new Date())} · day: {windowId("DAY", new Date())}
            </dd>
            <dt>fetched_at</dt>
            <dd>{usage.fetched_at}</dd>
          </dl>

          {(can("op:refund", usage.service_name) || can("op:reset", usage.service_name)) && (
            <div className="actions">
              {can("op:refund", usage.service_name) && <button onClick={doRefund}>Refund…</button>}
              {can("op:reset", usage.service_name) && <button onClick={doReset}>Reset window…</button>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
