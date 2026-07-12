// UTC-aligned window_id, matching parent §6.1 / Appendix B.2:
//   MINUTE → YYYYMMDDHHmm, DAY → YYYYMMDD, MONTH → YYYYMM.
// The Live Usage viewer (§2.4) computes this so the user doesn't have to know the
// encoding; the label is display-only (GetUsage resolves the window server-side).

export type TimeUnit = "MINUTE" | "DAY" | "MONTH";

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

export function windowId(unit: TimeUnit, date: Date = new Date()): string {
  const y = pad(date.getUTCFullYear(), 4);
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  switch (unit) {
    case "MINUTE":
      return `${y}${mo}${d}${h}${mi}`;
    case "DAY":
      return `${y}${mo}${d}`;
    case "MONTH":
      return `${y}${mo}`;
  }
}

// A human label for the current window, for the viewer's window picker.
export function windowLabel(unit: TimeUnit, date: Date = new Date()): string {
  switch (unit) {
    case "MINUTE":
      return `current minute (${windowId(unit, date)})`;
    case "DAY":
      return `today (${windowId(unit, date)})`;
    case "MONTH":
      return `this month (${windowId(unit, date)})`;
  }
}
