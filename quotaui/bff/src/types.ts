// Shared TS shapes for the BFF. These mirror the proto messages as decoded by
// @grpc/proto-loader (snake_case, enums-as-strings, int64-as-strings).

export type TimeUnit = "MINUTE" | "DAY" | "MONTH" | "TIME_UNIT_UNSPECIFIED";

export interface LimitKey {
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
}

// Flattened limit shape returned to the SPA (design §5.1).
export interface LimitView {
  config_id: number | null;
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
  limit_value: number;
  time_unit: TimeUnit;
  is_default: boolean;
}

export interface ServiceView {
  service_name: string;
  display_name: string;
  owner: string;
}

export interface UsageView {
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
  configured: boolean;
  limit: number | null;
  consumed: number;
  remaining: number;
  reset_at: string | null; // ISO-8601 UTC
  fetched_at: string; // ISO-8601 UTC — when the BFF read it
}

export interface AuditView {
  audit_id: number;
  config_id: number;
  operation: "INSERT" | "UPDATE" | "DELETE" | string;
  old_row: Record<string, unknown> | null;
  new_row: Record<string, unknown> | null;
  changed_by: string;
  changed_at: string | null; // ISO-8601 UTC
}
