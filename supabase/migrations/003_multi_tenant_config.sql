-- ============================================================================
-- 003_multi_tenant_config.sql
-- Multi-tenant configuration tables and schema extensions.
-- Enables per-org vertical templates, per-org Gmail OAuth tokens,
-- and self-service onboarding.
--
-- SAFE to run on production: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Does NOT modify candidates, candidate_scored, or sa_university_variants.
-- ============================================================================

-- ============================================================================
-- 1. vertical_templates
-- Stores AI prompt + extraction schema + gate rules per industry vertical.
-- Six built-in verticals seeded in 004_seed_vertical_templates.sql.
-- ============================================================================
CREATE TABLE IF NOT EXISTS vertical_templates (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 text UNIQUE NOT NULL,       -- slug: 'teaching', 'legal', 'tech', etc.
    display_name         text NOT NULL,              -- human-readable: 'Teaching', 'Legal', etc.
    ai_system_prompt     text NOT NULL,              -- full Claude system prompt for this vertical
    ai_extraction_schema text NOT NULL,              -- JSON schema description embedded in prompt
    gate_rules           jsonb NOT NULL DEFAULT '{}', -- hard/soft qualification rules
    scoring_config       jsonb NOT NULL DEFAULT '{}', -- weights for future scoring
    created_at           timestamptz DEFAULT now()
);

COMMENT ON TABLE vertical_templates IS 'Per-industry AI prompt and qualification gate configuration. One row per vertical.';
COMMENT ON COLUMN vertical_templates.gate_rules IS 'Shape: {"hard": [{field, op, value, reason}], "soft": [{field, op, value, reason}]}. Ops: eq, ne, lt, gt.';

-- ============================================================================
-- 2. org_gmail_tokens
-- Stores per-org Gmail OAuth refresh/access tokens for multi-inbox support.
-- One token per org (UNIQUE on organization_id).
-- Falls back to env GMAIL_REFRESH_TOKEN for orgs without a row here.
-- ============================================================================
CREATE TABLE IF NOT EXISTS org_gmail_tokens (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    gmail_email       text NOT NULL,        -- the connected Gmail address
    refresh_token     text NOT NULL,        -- long-lived refresh token
    access_token      text,                 -- cached access token (refreshed on expiry)
    token_expires_at  timestamptz,          -- when access_token expires
    scopes            text[],               -- granted OAuth scopes
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now(),
    UNIQUE(organization_id)
);

COMMENT ON TABLE org_gmail_tokens IS 'Per-org Gmail OAuth tokens. One row per org. Access token cached and refreshed automatically.';

-- updated_at trigger for org_gmail_tokens
CREATE OR REPLACE FUNCTION update_org_gmail_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_org_gmail_tokens_updated_at
    BEFORE UPDATE ON org_gmail_tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_org_gmail_tokens_updated_at();

-- ============================================================================
-- 3. Extend organizations
-- ============================================================================

-- Link to a vertical template (nullable — existing orgs inherit no vertical)
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS vertical_id uuid REFERENCES vertical_templates(id);

-- Per-org overrides (optional — takes precedence over vertical_templates)
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS ai_prompt_override text;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS gate_rules_override jsonb;

-- Onboarding lifecycle status
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS onboarding_status text
        CHECK (onboarding_status IN ('pending', 'gmail_connected', 'active'))
        DEFAULT 'pending';

-- Contact person for the org (captured during self-service onboarding)
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS contact_name text;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS contact_email text;

COMMENT ON COLUMN organizations.vertical_id IS 'Which vertical template to use. NULL = fallback to shared env token + teaching logic for backward compat.';
COMMENT ON COLUMN organizations.onboarding_status IS 'pending=just created, gmail_connected=OAuth done, active=pipeline running.';

-- ============================================================================
-- 4. Extend candidates
-- ============================================================================

-- Full raw extraction from Claude (vertical-specific fields stored here)
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS raw_extraction jsonb;

-- Which vertical processed this candidate
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS vertical text;

COMMENT ON COLUMN candidates.raw_extraction IS 'Full JSON object returned by Claude for this candidate. Vertical-specific fields live here.';
COMMENT ON COLUMN candidates.vertical IS 'Vertical name (teaching, legal, tech, etc.) that processed this candidate.';

-- ============================================================================
-- 5. Extend inbound_email_routes
-- ============================================================================

-- Link to the org Gmail token to use for this route
-- NULL = fall back to shared GMAIL_REFRESH_TOKEN env secret (Nicole's existing setup)
ALTER TABLE inbound_email_routes
    ADD COLUMN IF NOT EXISTS gmail_token_id uuid REFERENCES org_gmail_tokens(id);

COMMENT ON COLUMN inbound_email_routes.gmail_token_id IS 'Per-org Gmail token. NULL = use shared env GMAIL_REFRESH_TOKEN (backward compat for Nicole).';

-- ============================================================================
-- 6. RLS policies
-- ============================================================================

ALTER TABLE vertical_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_gmail_tokens ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, but these policies allow the edge function full access
CREATE POLICY "Service role full access on vertical_templates"
    ON vertical_templates FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Service role full access on org_gmail_tokens"
    ON org_gmail_tokens FOR ALL
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- 7. Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_vertical_templates_name
    ON vertical_templates (name);

CREATE INDEX IF NOT EXISTS idx_org_gmail_tokens_org_id
    ON org_gmail_tokens (organization_id);

CREATE INDEX IF NOT EXISTS idx_organizations_vertical_id
    ON organizations (vertical_id)
    WHERE vertical_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidates_vertical
    ON candidates (vertical)
    WHERE vertical IS NOT NULL;
