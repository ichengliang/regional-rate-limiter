-- Seed config for manual verification of quotaenforcer (design examples §3.5).
-- Run with: psql "$PGDATABASE" -f scripts/seed.sql   (PG* env from repo .env)
--
-- NOTE: limit_config is audited; the trigger requires app.actor to be set.
BEGIN;
SET LOCAL app.actor = 'manual-seed';

INSERT INTO service(service_name, display_name, owner)
  VALUES ('search-svc', 'Search Service', 'search-team')
  ON CONFLICT (service_name) DO NOTHING;

INSERT INTO limit_config(service_name, customer_id, rate_limit_id, limit_value, time_unit) VALUES
  ('search-svc', 'cust_42', 'requests_per_min',   1000, 'MINUTE'),  -- exact customer override
  ('search-svc', '*',       'requests_per_min',    100, 'MINUTE'),  -- per-(svc,rlid) default
  ('search-svc', 'org_9',   'org_tokens_per_day', 50000, 'DAY')     -- a DAY-window limit
  ON CONFLICT (service_name, customer_id, rate_limit_id)
  DO UPDATE SET limit_value = EXCLUDED.limit_value, time_unit = EXCLUDED.time_unit;

COMMIT;
