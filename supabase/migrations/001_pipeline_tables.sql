-- ============================================================================
-- 001_pipeline_tables.sql
-- New tables for the Amalfi CV processing pipeline
-- These tables support idempotent email processing, full audit logging,
-- and daily run summaries.
-- DOES NOT modify any existing tables (candidates, candidate_scored,
-- sa_university_variants, inbound_email_routes, organizations).
-- ============================================================================

-- ============================================================================
-- 1. email_queue
-- Tracks every Gmail message fetched. Prevents re-processing via unique
-- constraint on (gmail_message_id, organization_id).
-- ============================================================================
CREATE TABLE IF NOT EXISTS email_queue (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid,                          -- FK to processing_runs
    organization_id uuid NOT NULL,                 -- FK to organizations
    user_id         uuid NOT NULL,
    route_id        uuid,                          -- FK to inbound_email_routes
    gmail_message_id text NOT NULL,                -- Gmail API message ID
    gmail_thread_id  text,                         -- Gmail API thread ID
    sender_email    text,                          -- From header
    subject         text,                          -- Email subject
    email_date      timestamptz,                   -- Date header from email
    attachment_count integer DEFAULT 0,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                        'pending',        -- fetched, not yet processed
                        'processing',     -- currently being processed
                        'completed',      -- all attachments processed
                        'failed',         -- unrecoverable error
                        'skipped'         -- e.g., no valid attachments
                    )),
    error_message   text,                          -- if status = 'failed'
    processed_at    timestamptz,                   -- when processing completed
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- Idempotency: never process the same Gmail message twice per org
    CONSTRAINT uq_email_queue_message_org UNIQUE (gmail_message_id, organization_id)
);

-- Index for finding unprocessed emails
CREATE INDEX IF NOT EXISTS idx_email_queue_status
    ON email_queue (status)
    WHERE status IN ('pending', 'processing');

-- Index for run-level queries
CREATE INDEX IF NOT EXISTS idx_email_queue_run_id
    ON email_queue (run_id);

-- Index for org-level queries
CREATE INDEX IF NOT EXISTS idx_email_queue_org_id
    ON email_queue (organization_id);


-- ============================================================================
-- 2. pipeline_audit_log
-- Every candidate at every pipeline stage. This is the primary debugging
-- tool — log generously with clear reasons.
-- ============================================================================
CREATE TABLE IF NOT EXISTS pipeline_audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid,                          -- FK to processing_runs
    email_queue_id  uuid,                          -- FK to email_queue (which email)
    organization_id uuid NOT NULL,
    user_id         uuid,

    -- What stage of the pipeline
    stage           text NOT NULL
                    CHECK (stage IN (
                        'email_fetched',           -- email downloaded from Gmail
                        'attachment_downloaded',    -- individual attachment fetched
                        'attachment_skipped',       -- attachment filtered out (type/size)
                        'ai_extraction',            -- sent to Claude, got response
                        'ai_not_cv',                -- Claude said: not a CV
                        'ai_error',                 -- Claude API error
                        'qualification_gate',       -- business rule evaluation
                        'hallucination_check',      -- fake name check
                        'dedup_check',              -- deduplication check
                        'candidate_inserted',       -- successfully inserted into candidates
                        'candidate_rejected',       -- rejected by a gate
                        'candidate_skipped',        -- skipped (duplicate, etc.)
                        'error'                     -- unexpected error
                    )),

    -- What happened
    action          text NOT NULL
                    CHECK (action IN (
                        'pass',                    -- passed this stage
                        'reject',                  -- hard rejection
                        'skip',                    -- skipped (not rejected, just not relevant)
                        'flag',                    -- soft flag (logged but not rejected)
                        'error',                   -- error occurred
                        'info'                     -- informational log entry
                    )),

    -- Human-readable reason
    reason          text,

    -- Context data (flexible JSON for stage-specific details)
    -- e.g., filename, mime_type, candidate_name, AI response snippet, etc.
    context         jsonb DEFAULT '{}',

    -- Reference to the candidate if one was created
    candidate_id    uuid,                          -- FK to candidates.id (nullable)
    candidate_name  text,                          -- denormalized for quick log reading

    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for finding all logs for a specific run
CREATE INDEX IF NOT EXISTS idx_audit_log_run_id
    ON pipeline_audit_log (run_id);

-- Index for finding all logs for a specific email
CREATE INDEX IF NOT EXISTS idx_audit_log_email_queue_id
    ON pipeline_audit_log (email_queue_id);

-- Index for finding all logs for a specific candidate
CREATE INDEX IF NOT EXISTS idx_audit_log_candidate_id
    ON pipeline_audit_log (candidate_id)
    WHERE candidate_id IS NOT NULL;

-- Index for filtering by stage/action
CREATE INDEX IF NOT EXISTS idx_audit_log_stage_action
    ON pipeline_audit_log (stage, action);

-- Index for org-level audit queries
CREATE INDEX IF NOT EXISTS idx_audit_log_org_id
    ON pipeline_audit_log (organization_id);


-- ============================================================================
-- 3. processing_runs
-- One row per daily pipeline invocation. Summarizes what happened for
-- monitoring and debugging.
-- ============================================================================
CREATE TABLE IF NOT EXISTS processing_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid,                          -- NULL if processing all orgs
    target_day      date NOT NULL,                 -- the day being processed
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN (
                        'running',
                        'completed',
                        'completed_with_errors',
                        'failed'
                    )),

    -- Summary stats (populated on completion)
    routes_processed   integer DEFAULT 0,
    emails_fetched     integer DEFAULT 0,
    attachments_total  integer DEFAULT 0,
    attachments_processed integer DEFAULT 0,
    attachments_skipped integer DEFAULT 0,
    candidates_extracted integer DEFAULT 0,
    candidates_inserted integer DEFAULT 0,
    candidates_rejected integer DEFAULT 0,
    candidates_duplicates integer DEFAULT 0,
    ai_calls_made      integer DEFAULT 0,
    errors_count       integer DEFAULT 0,

    -- Timing
    started_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    duration_ms     integer,                       -- total runtime in milliseconds

    -- Error details if failed
    error_message   text,

    -- Metadata
    triggered_by    text DEFAULT 'cron'            -- 'cron', 'manual', 'backfill'
                    CHECK (triggered_by IN ('cron', 'manual', 'backfill')),
    config          jsonb DEFAULT '{}',            -- any run-specific config

    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for finding runs by day
CREATE INDEX IF NOT EXISTS idx_processing_runs_target_day
    ON processing_runs (target_day);

-- Index for finding recent runs
CREATE INDEX IF NOT EXISTS idx_processing_runs_status
    ON processing_runs (status, started_at DESC);


-- ============================================================================
-- 4. Helper: updated_at trigger for email_queue
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_email_queue_updated_at
    BEFORE UPDATE ON email_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ============================================================================
-- 5. RLS Policies (basic — service role bypasses, but good practice)
-- ============================================================================
ALTER TABLE email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_runs ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (edge functions use service role key)
CREATE POLICY "Service role full access on email_queue"
    ON email_queue FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Service role full access on pipeline_audit_log"
    ON pipeline_audit_log FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Service role full access on processing_runs"
    ON processing_runs FOR ALL
    USING (true)
    WITH CHECK (true);


-- ============================================================================
-- 6. Comments for documentation
-- ============================================================================
COMMENT ON TABLE email_queue IS 'Tracks every Gmail message fetched by the pipeline. Idempotent by gmail_message_id + organization_id.';
COMMENT ON TABLE pipeline_audit_log IS 'Full audit trail: every candidate at every pipeline stage with action + reason. Primary debugging tool.';
COMMENT ON TABLE processing_runs IS 'One row per daily pipeline invocation with summary stats for monitoring.';
