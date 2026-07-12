-- Regional Rate Limiter — control-plane schema (source of truth for configs).
-- Postgres. Low QPS, strongly consistent, audited. Never in the hot path.
-- One deployment per region, so no region column; limits are always enabled.
-- See regional-rate-limiter-design.md Appendix B.1.

BEGIN;

-- ---------- enums ----------
-- Fixed-window is the only algorithm and fail-open is the only failure mode,
-- so neither is modeled as a column.
CREATE TYPE time_unit AS ENUM ('MINUTE', 'DAY', 'MONTH');

-- ---------- registered producers (optional, for authz + FK) ----------
CREATE TABLE service (
    service_name  TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    owner         TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- the core config table ----------
-- Lean by design: identity + the limit itself. All who/when history lives in
-- limit_config_audit, so no created/updated columns here.
CREATE TABLE limit_config (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    service_name  TEXT        NOT NULL REFERENCES service(service_name),
    -- '*' = the per-(service, rate_limit_id) DEFAULT applied to any customer
    -- without an explicit override. An exact customer_id row wins over '*'.
    customer_id   TEXT        NOT NULL,
    rate_limit_id TEXT        NOT NULL,

    limit_value   BIGINT      NOT NULL CHECK (limit_value >= 0),  -- the cap
    time_unit     time_unit   NOT NULL,               -- MINUTE | DAY | MONTH (fixed window)

    CONSTRAINT uq_limit UNIQUE (service_name, customer_id, rate_limit_id)
);

CREATE INDEX idx_limit_service ON limit_config (service_name);

-- Resolution the data plane runs on a config-cache miss: exact customer row if
-- present, else the '*' default; no row => limit unconfigured => allow (§6.2, §9).
--   SELECT limit_value, time_unit
--     FROM limit_config
--    WHERE service_name = :svc AND rate_limit_id = :rlid
--      AND customer_id IN (:cust, '*')
--    ORDER BY (customer_id = '*')   -- FALSE (exact) sorts before TRUE (default)
--    LIMIT 1;

-- ---------- append-only audit / change history ----------
-- The full record of every change: before + after values, who, and when.
-- Also doubles as the change-feed the data plane polls to refresh its cache.
CREATE TABLE limit_config_audit (
    audit_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    config_id     BIGINT      NOT NULL,
    operation     TEXT        NOT NULL,      -- INSERT | UPDATE | DELETE
    old_row       JSONB,                     -- value before (NULL on INSERT)
    new_row       JSONB,                     -- value after  (NULL on DELETE)
    changed_by    TEXT        NOT NULL,      -- actor: creator on INSERT, updater on UPDATE/DELETE
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_config     ON limit_config_audit (config_id, changed_at);
-- data-plane nodes poll "what changed since X?" off this index to refresh cache (§12.4)
CREATE INDEX idx_audit_changed_at ON limit_config_audit (changed_at);

-- Actor is supplied by the app per transaction via a session GUC, so it never
-- has to live on limit_config:  SET LOCAL app.actor = 'alice';
CREATE OR REPLACE FUNCTION limit_config_audit_write() RETURNS TRIGGER AS $$
DECLARE
    actor TEXT := current_setting('app.actor', true);   -- true = don't error if unset
BEGIN
    IF actor IS NULL OR actor = '' THEN
        RAISE EXCEPTION 'app.actor must be set (SET LOCAL app.actor = ...) before writing limit_config';
    END IF;

    IF (TG_OP = 'INSERT') THEN
        INSERT INTO limit_config_audit(config_id, operation, old_row, new_row, changed_by)
        VALUES (NEW.id, 'INSERT', NULL, to_jsonb(NEW), actor);
        RETURN NEW;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO limit_config_audit(config_id, operation, old_row, new_row, changed_by)
        VALUES (NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), actor);
        RETURN NEW;
    ELSE  -- DELETE
        INSERT INTO limit_config_audit(config_id, operation, old_row, new_row, changed_by)
        VALUES (OLD.id, 'DELETE', to_jsonb(OLD), NULL, actor);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_limit_config_audit
    AFTER INSERT OR UPDATE OR DELETE ON limit_config
    FOR EACH ROW EXECUTE FUNCTION limit_config_audit_write();

COMMIT;
