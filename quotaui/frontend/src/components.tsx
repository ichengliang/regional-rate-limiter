// Small shared UI pieces. Accessibility per §7.1: state is never encoded by color
// alone — badges carry text; over-quota carries an icon + text.
import type { ReactNode } from "react";
import { diffRows } from "./util/diff";

export function KindBadge({ isDefault }: { isDefault: boolean }) {
  return (
    <span className={`badge ${isDefault ? "badge-default" : "badge-override"}`}>
      {isDefault ? "DEFAULT" : "OVERRIDE"}
    </span>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <p className="error" role="alert">
      {msg}
    </p>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

// before → after table, shared by the editor preview and audit rendering.
export function DiffTable({
  oldRow,
  newRow,
}: {
  oldRow: Record<string, unknown> | null;
  newRow: Record<string, unknown> | null;
}) {
  const rows = diffRows(oldRow, newRow);
  const fmt = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));
  return (
    <table className="diff">
      <tbody>
        {rows.map((r) => (
          <tr key={r.field} className={r.changed ? "changed" : ""}>
            <th scope="row">{r.field}</th>
            <td>{fmt(r.before)}</td>
            <td aria-hidden>→</td>
            <td>{fmt(r.after)}</td>
            <td>{r.changed ? "changed" : "unchanged"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
