// Service Registration / Management (§2.3).
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useSession } from "../session";
import { ErrorText, Field } from "../components";
import type { ServiceView } from "../types";

export function Services() {
  const { can } = useSession();
  const [services, setServices] = useState<ServiceView[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<ServiceView>({ service_name: "", display_name: "", owner: "" });
  const [editingName, setEditingName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setServices((await api.listServices()).services);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setError(null);
    try {
      if (editingName) {
        await api.updateService(editingName, { display_name: form.display_name, owner: form.owner });
      } else {
        await api.createService(form);
      }
      setForm({ service_name: "", display_name: "", owner: "" });
      setEditingName(null);
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <h2>Services</h2>
      <ErrorText error={error} />
      <table className="grid">
        <thead>
          <tr>
            <th>Service</th>
            <th>Display name</th>
            <th>Owner</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.service_name}>
              <td>{s.service_name}</td>
              <td>{s.display_name}</td>
              <td>{s.owner}</td>
              <td>
                {can("service:edit", s.service_name) && (
                  <button
                    onClick={() => {
                      setForm(s);
                      setEditingName(s.service_name);
                    }}
                  >
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
          {services.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                no services registered
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {(can("service:create", form.service_name) || editingName) && (
        <div className="panel">
          <h3>{editingName ? `Edit ${editingName}` : "Register a service"}</h3>
          <Field label="Service name (immutable)">
            <input
              value={form.service_name}
              disabled={Boolean(editingName)}
              onChange={(e) => setForm({ ...form, service_name: e.target.value })}
            />
          </Field>
          <Field label="Display name">
            <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </Field>
          <Field label="Owner">
            <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
          </Field>
          <div className="actions">
            {editingName && (
              <button
                onClick={() => {
                  setEditingName(null);
                  setForm({ service_name: "", display_name: "", owner: "" });
                }}
              >
                Cancel
              </button>
            )}
            <button className="primary" onClick={submit}>
              {editingName ? "Save" : "Register"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
