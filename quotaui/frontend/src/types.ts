// Response shapes returned by the BFF (mirrors bff/src/types.ts).
import type { Grant } from "./util/rbac";

export type TimeUnit = "MINUTE" | "DAY" | "MONTH";

export interface SessionInfo {
  user: { id: string; email: string };
  grants: Grant[];
  editable_services: string[];
  csrf_token: string;
}

export interface LimitView {
  config_id: number | null;
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
  limit_value: number;
  time_unit: TimeUnit;
  is_default: boolean;
}

export interface ResolveView extends Partial<LimitView> {
  configured: boolean;
  note?: string;
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
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
  reset_at: string | null;
  fetched_at: string;
}

export interface AuditView {
  audit_id: number;
  config_id: number;
  operation: string;
  old_row: Record<string, unknown> | null;
  new_row: Record<string, unknown> | null;
  changed_by: string;
  changed_at: string | null;
}

export interface Review {
  id: string;
  op: Record<string, unknown> & { kind: string };
  reason: string;
  initiator: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface Key {
  service_name: string;
  customer_id: string;
  rate_limit_id: string;
}
