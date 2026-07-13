// Audit / History Browser (§2.6). Read-only; field-level diff of old_row→new_row.
import { Fragment, useState } from "react";
import { api } from "../api";
import { ErrorText, Field, DiffTable } from "../components";
import type { AuditView } from "../types";

export function AuditBrowser() {
  const [service, setService] = useState("");
  const [customer, setCustomer] = useState("");
  const [rlid, setRlid] = useState("");
  const [changedBy, setChangedBy] = useState("");
  const [operation, setOperation] = useState("");
  const [entries, setEntries] = useState<AuditView[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const search = async () => {
    setError(null);
    try {
      const res = await api.listAudit({
        service_name: service,
        customer_id: customer || undefined,
        rate_limit_id: rlid || undefined,
        changed_by: changedBy || undefined,
        operation: operation || undefined,
      });
      setEntries(res.entries);
    } catch (e) {
      setError(e);
      setEntries([]);
    }
  };

  return (
    <section>
      <h2>Audit / history</h2>
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
        <Field label="By">
          <input value={changedBy} onChange={(e) => setChangedBy(e.target.value)} />
        </Field>
        <Field label="Op">
          <select value={operation} onChange={(e) => setOperation(e.target.value)}>
            <option value="">all</option>
            <option value="INSERT">INSERT</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
          </select>
        </Field>
        <button onClick={search}>Search</button>
      </div>

      <ErrorText error={error} />

      <table className="grid">
        <thead>
          <tr>
            <th>When (UTC)</th>
            <th>By</th>
            <th>Op</th>
            <th>Config</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <Fragment key={e.audit_id}>
              <tr>
                <td>{e.changed_at}</td>
                <td>{e.changed_by}</td>
                <td>{e.operation}</td>
                <td>#{e.config_id}</td>
                <td>
                  <button onClick={() => setExpanded(expanded === e.audit_id ? null : e.audit_id)}>
                    {expanded === e.audit_id ? "hide" : "diff"}
                  </button>
                </td>
              </tr>
              {expanded === e.audit_id && (
                <tr>
                  <td colSpan={5}>
                    <DiffTable oldRow={e.old_row} newRow={e.new_row} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                no entries — search a service
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
