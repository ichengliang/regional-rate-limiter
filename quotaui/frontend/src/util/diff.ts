// Field-level before→after diff, used by the Limit Editor change preview (§6.2)
// and the Audit browser rendering (§2.6). Both compare the same old_row/new_row
// shape that lands in limit_config_audit.

export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
  changed: boolean;
}

export function diffRows(
  oldRow: Record<string, unknown> | null | undefined,
  newRow: Record<string, unknown> | null | undefined,
): FieldDiff[] {
  const keys = new Set([...Object.keys(oldRow ?? {}), ...Object.keys(newRow ?? {})]);
  return [...keys].sort().map((field) => {
    const before = oldRow?.[field];
    const after = newRow?.[field];
    return { field, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
  });
}
