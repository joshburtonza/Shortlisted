# CLAUDE.md — Amalfi CV Processor

## What This Project Is

A Supabase Edge Function pipeline that replaces an n8n workflow for a South African teacher recruitment agency (SA-Recruitment). It processes CVs from Gmail, extracts candidate data using Claude Haiku, applies qualification business rules, and inserts passing candidates into a Supabase database that feeds an existing dashboard.

## Why We're Rebuilding

The existing n8n system has critical bugs:
- **Filename filtering drops good candidates** — Gmail query blocks filenames containing words like "degree", "pgce", "cover letter", "sace". These are common in SA teacher CV filenames. A real candidate (Anje van Niekerk) was dropped because her CV was named "UAE CV Anje Cover Letter.pdf".
- **DeepSeek AI hallucinations** — The LLM fabricates fake candidates (e.g., "John Smith", "Sarah Johnson") that pollute the dashboard.
- **No qualification enforcement** — Unqualified candidates (no degree, diploma-only, non-SA) reach the dashboard because there's no business rule gate.
- **No audit trail** — When a candidate is missing or shouldn't be there, there's no way to trace why without re-running the entire workflow.
- **Not multi-tenant ready** — Hardcoded user/org IDs. We want to white-label this for other recruitment agencies.

## The Existing System We Must Integrate With

### Supabase Database (MUST NOT CHANGE these existing tables)
- `candidates` table — where parsed candidates are inserted
- `candidate_scored` view — adds scoring columns, read by the dashboard
- `sa_university_variants` table — canonical SA university names + variants for matching
- `inbound_email_routes` table — maps source emails to user_id + organization_id (multi-tenant routing)
- `organizations` table — tenant records

See `reference/supabase-schema.csv` for full column definitions.

### Existing Edge Function (KEEP AS BACKUP)
`n8n-ingest-candidates` — the current ingest endpoint. Our new system inserts directly into `candidates` table, matching the exact same column structure. See `reference/n8n-ingest-edge-function.ts`.

### Dashboard (DO NOT TOUCH)
Reads from `candidate_scored` view. We don't touch it. As long as we insert valid rows into `candidates`, the dashboard works.

## What To Build

A set of Supabase Edge Functions that form a daily processing pipeline:

### Pipeline Flow
```
pg_cron trigger (daily 2:30AM SAST / 00:30 UTC)
  → process-candidates edge function
    → For each route in inbound_email_routes:
      → Gmail API: fetch yesterday's emails with attachments
      → For each email:
        → Download ALL document attachments (PDF, DOC, DOCX, RTF)
        → NO FILENAME FILTERING (only block images/media/archives)
        → For each document attachment:
          → Send to Claude Haiku API (accepts PDFs natively as base64)
          → Claude determines: is this a CV? If yes, extract candidate JSON
          → If not a CV (cover letter, certificate, etc.): log and skip
          → Apply qualification gate (hard business rules)
          → Deduplication check (24h window)
          → Insert into candidates table
        → Log EVERY step to pipeline_audit_log
```

### New Tables Required
1. **email_queue** — tracks every email fetched, prevents re-processing (idempotent by gmail_message_id + org_id)
2. **pipeline_audit_log** — every candidate at every stage with action + reason
3. **processing_runs** — daily run summaries for monitoring

### Qualification Gate Rules (HARD REQUIREMENTS from the client)
1. **Must have an education degree** — `has_education_degree` must be true. BEd, BA Education, BSc Education, BCom Education, or PGCE with underlying degree. Diplomas alone = reject. Certificates alone = reject. Students = reject.
2. **Must be from South Africa** — `countries_raw` must include South Africa, OR `degree_country_raw` must be South Africa, OR `current_location_raw` indicates SA.
3. **Degree must be from a registered SA tertiary institution** — cross-reference against `sa_university_variants` table.
4. **No hallucinated candidates** — block known placeholder names (John Smith, Jane Doe, Sarah Johnson, etc.)
5. **Experience is a soft signal** — low experience gets flagged in audit but not hard-rejected (client may want new graduates).

### Attachment Filtering Rules
- **ALLOW:** PDF, DOC, DOCX, RTF — regardless of filename
- **BLOCK:** Images (png, jpg, jpeg, gif, heic, webp, svg), media (mp3, mp4), archives (zip, rar), executables, spreadsheets
- **SIZE:** Skip files under 5KB or over 15MB
- **NO FILENAME KEYWORD FILTERING** — this was the #1 bug source in n8n. A CV named "cover letter.pdf" is still a CV. Let the AI decide.

### Claude Haiku Integration
- Model: `claude-haiku-4-5-20251001`
- Send PDFs as base64 documents (Claude reads them natively — no separate PDF extraction needed)
- For DOCX: also send as base64 documents
- System prompt must instruct Claude to:
  - Return ONLY valid JSON
  - Return `{"candidates": []}` if the document is not a CV
  - Never fabricate candidates
  - Extract all fields matching the `candidates` table schema
- Expected cost: ~$0.002 per CV, ~$3/month for 1,500 CVs

### Environment Variables (Supabase Edge Function Secrets)
```
SUPABASE_URL          — auto-provided by Supabase
SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase
ANTHROPIC_API_KEY     — Anthropic API key for Claude Haiku
GMAIL_CLIENT_ID       — Google OAuth client ID
GMAIL_CLIENT_SECRET   — Google OAuth client secret
GMAIL_REFRESH_TOKEN   — Gmail OAuth refresh token (per-route in future, single for now)
```

## Technical Constraints

- **Supabase Edge Functions run Deno** (TypeScript, no Node.js)
- **150-second timeout** on free plan, 400 seconds on Pro
- **If processing 50+ emails could exceed timeout:** implement batching — process N emails per invocation, use email_queue status to track progress, re-invoke if needed
- **All external imports must use esm.sh or cdn.skypack.dev URLs**
- **No file system access** — everything in memory or Supabase storage

## Code Style

- TypeScript, clean types for all data structures
- Comprehensive error handling — one bad email should never crash the whole run
- Console.log for edge function debugging (visible in Supabase logs)
- Audit log table is the primary debugging tool — log generously with clear reasons

## Testing Strategy

1. Deploy alongside n8n (both systems run, dedup prevents double-inserts)
2. Process a specific historical day: `POST /process-candidates {"target_day": "2025-02-10"}`
3. Compare results: what n8n inserted vs what new system inserted
4. Check audit log for any candidates gated out
5. Run parallel for 3-5 days before disabling n8n

## File Structure
```
/
├── CLAUDE.md                              (this file)
├── supabase/
│   ├── migrations/
│   │   └── 001_pipeline_tables.sql        (email_queue, audit_log, processing_runs)
│   └── functions/
│       └── process-candidates/
│           └── index.ts                   (main processor)
├── reference/
│   ├── supabase-schema.csv                (existing table schemas)
│   ├── n8n-ingest-edge-function.ts        (existing edge function — for reference only)
│   ├── n8n-workflow-analysis.md           (what the old system does and its bugs)
│   └── business-rules.md                  (Nicole's requirements)
└── docs/
    └── DEPLOYMENT.md                      (step-by-step deployment guide)
```
