// Limits Browser (§2.1) + inline Limit Editor (§2.2).
import { useCallback, useState } from "react";
import { api, isPending } from "../api";
import { useSession } from "../session";
import { ErrorText, Field, KindBadge, DiffTable } from "../components";
import type { LimitView, ResolveView, TimeUnit } from "../types";

const UNITS: TimeUnit[] = ["MINUTE", "DAY", "MONTH"];
const EMPTY: LimitView = {
  config_id: null,
  service_name: "",
  customer_id: "",
  rate_limit_id: "",
  limit_value: 0,
  time_unit: "MINUTE",
  is_default: false,
};

export function LimitsBrowser() {
  const { can } = useSession();
  const [service, setService] = useState("");
  const [customer, setCustomer] = useState("");
  const [rlid, setRlid] = useState("");
  const [kind, setKind] = useState<"all" | "defaults" | "overrides">("all");
  const [limits, setLimits] = useState<LimitView[]>([]);
  const [effective, setEffective] = useState<ResolveView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<LimitView | null>(null);

  const search = useCallback(async () => {
    setError(null);
    if (!service) {
      setError("pick a service");
      return;
    }
    try {
      const res = await api.listLimits({
        service_name: service,
        customer_id: kind === "defaults" ? "*" : customer || undefined,
        rate_limit_id: rlid || undefined,
      });
      let rows = res.limits;
      if (kind === "overrides") rows = rows.filter((l) => !l.is_default);
      setLimits(rows);
      // Effective-limit hint when a concrete customer + rlid are given (§2.1).
      if (customer && customer !== "*" && rlid) {
        setEffective(
          await api.resolveLimit({ service_name: service, customer_id: customer, rate_limit_id: rlid }),
        );
      } else {
        setEffective(null);
      }
    } catch (e) {
      setError(e);
      setLimits([]);
    }
  }, [service, customer, rlid, kind]);

  return (
    <section>
      <h2>Limits</h2>
      <div className="filters">
        <Field label="Service">
          <input value={service} onChange={(e) => setService(e.target.value)} placeholder="search-svc" />
        </Field>
        <Field label="Customer">
          <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="cust_42 or *" />
        </Field>
        <Field label="Rate limit id">
          <input value={rlid} onChange={(e) => setRlid(e.target.value)} placeholder="default" />
        </Field>
        <Field label="Show">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">all</option>
            <option value="defaults">defaults only</option>
            <option value="overrides">overrides only</option>
          </select>
        </Field>
        <button onClick={search}>Search</button>
        {can("limit:write", service) && (
          <button onClick={() => setEditing({ ...EMPTY, service_name: service })}>+ New limit</button>
        )}
      </div>

      <ErrorText error={error} />

      <table className="grid">
        <thead>
          <tr>
            <th>Service</th>
            <th>Customer</th>
            <th>RL id</th>
            <th>Limit</th>
            <th>Unit</th>
            <th>Kind</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {limits.map((l) => (
            <tr key={`${l.customer_id}|${l.rate_limit_id}`}>
              <td>{l.service_name}</td>
              <td>{l.customer_id}</td>
              <td>{l.rate_limit_id}</td>
              <td>{l.limit_value}</td>
              <td>{l.time_unit}</td>
              <td>
                <KindBadge isDefault={l.is_default} />
              </td>
              <td>
                {can("limit:write", l.service_name) ? (
                  <button onClick={() => setEditing(l)}>Edit</button>
                ) : (
                  <span className="muted">read-only</span>
                )}
              </td>
            </tr>
          ))}
          {limits.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                no limits — search a service
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {effective && (
        <p className="hint">
          {effective.configured
            ? `Effective for ${effective.customer_id}/${effective.rate_limit_id}: ${effective.limit_value}/${effective.time_unit} (${effective.is_default ? "via '*' default" : "override"})`
            : `Effective for ${effective.customer_id}/${effective.rate_limit_id}: ${effective.note}`}
        </p>
      )}

      {editing && (
        <LimitEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void search();
          }}
        />
      )}
    </section>
  );
}

function LimitEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: LimitView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = initial.config_id === null;
  const [form, setForm] = useState<LimitView>(initial);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");

  const oldRow = isNew
    ? null
    : { limit_value: initial.limit_value, time_unit: initial.time_unit };
  const newRow = { limit_value: Number(form.limit_value), time_unit: form.time_unit };
  const tuple = `${form.service_name}/${form.customer_id}/${form.rate_limit_id}`;

  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      if (isNew) {
        await api.createLimit({ ...form, limit_value: Number(form.limit_value) });
        onSaved();
      } else {
        const res = await api.updateLimit({ ...form, limit_value: Number(form.limit_value) });
        if (isPending(res)) {
          setNotice(`Change requires two-person review: ${res.review.reason}`);
        } else {
          onSaved();
        }
      }
    } catch (e) {
      setError(e);
    }
  };

  const del = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.deleteLimit({
        service_name: form.service_name,
        customer_id: form.customer_id,
        rate_limit_id: form.rate_limit_id,
      });
      if (isPending(res)) {
        setNotice(`Delete requires two-person review: ${res.review.reason}`);
      } else {
        onSaved();
      }
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="panel" role="dialog" aria-label={isNew ? "Create limit" : "Edit limit"}>
      <h3>{isNew ? "Create limit" : "Edit limit"}</h3>
      <Field label="Service">
        <input value={form.service_name} disabled={!isNew} onChange={(e) => setForm({ ...form, service_name: e.target.value })} />
      </Field>
      <Field label="Customer ('*' = default for all)">
        <input value={form.customer_id} disabled={!isNew} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} />
      </Field>
      <Field label="Rate limit id">
        <input value={form.rate_limit_id} disabled={!isNew} onChange={(e) => setForm({ ...form, rate_limit_id: e.target.value })} />
      </Field>
      <Field label="Limit value (≥ 0)">
        <input
          type="number"
          value={form.limit_value}
          onChange={(e) => setForm({ ...form, limit_value: Number(e.target.value) })}
        />
      </Field>
      <Field label="Unit">
        <select value={form.time_unit} onChange={(e) => setForm({ ...form, time_unit: e.target.value as TimeUnit })}>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </Field>

      {form.customer_id === "*" && (
        <p className="warn">
          ⚠ This is a '*' default — it applies to every customer of {form.service_name}/
          {form.rate_limit_id} without an explicit override.
        </p>
      )}

      <h4>Change preview (→ limit_config_audit)</h4>
      <DiffTable oldRow={oldRow} newRow={newRow} />

      <ErrorText error={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save}>
          {isNew ? "Create" : "Save change"}
        </button>
      </div>

      {!isNew && (
        <div className="delete-box">
          <p>
            Delete? Type <code>{tuple}</code> to confirm:
          </p>
          <input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} />
          <button className="danger" disabled={confirmDelete !== tuple} onClick={del}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
