# Deployment Guide — Amalfi CV Processor

## Prerequisites

- Supabase project (Pro plan recommended for 400s edge function timeout)
- Supabase CLI installed (`npm install -g supabase`)
- Google Cloud project with Gmail API enabled
- Anthropic API key (Claude Haiku access)

## Step 1: Run the SQL Migration

Apply the migration to create the three new pipeline tables:

```bash
supabase db push
```

Or run manually in Supabase SQL Editor:
1. Go to your Supabase dashboard → SQL Editor
2. Paste the contents of `supabase/migrations/001_pipeline_tables.sql`
3. Run the query

This creates:
- `email_queue` — idempotent email tracking
- `pipeline_audit_log` — full audit trail
- `processing_runs` — daily run summaries

**Does NOT modify** existing tables (`candidates`, `candidate_scored`, `sa_university_variants`, `inbound_email_routes`, `organizations`).

## Step 2: Set Environment Variables

Set these as Supabase Edge Function secrets:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
supabase secrets set GMAIL_CLIENT_SECRET=your-client-secret
supabase secrets set GMAIL_REFRESH_TOKEN=your-refresh-token
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-provided by Supabase.

### Getting Gmail Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Gmail API**
4. Create **OAuth 2.0 credentials** (type: Web Application)
5. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI
6. Go to [OAuth Playground](https://developers.google.com/oauthplayground/)
7. Click the gear icon → check "Use your own OAuth credentials" → enter your client ID and secret
8. Select `Gmail API v1` → `https://www.googleapis.com/auth/gmail.readonly`
9. Authorize and exchange for tokens
10. Copy the **refresh token**

## Step 3: Deploy the Edge Function

```bash
supabase functions deploy process-candidates --no-verify-jwt
```

The `--no-verify-jwt` flag allows pg_cron to call it without auth headers.

## Step 4: Test with a Specific Day

Send a manual test to process a specific historical day:

```bash
curl -X POST \
  'https://YOUR-PROJECT.supabase.co/functions/v1/process-candidates' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"target_day": "2025-02-10"}'
```

Check results:
- **Processing run:** `SELECT * FROM processing_runs ORDER BY created_at DESC LIMIT 1;`
- **Audit log:** `SELECT stage, action, reason, candidate_name FROM pipeline_audit_log WHERE run_id = '<run_id>' ORDER BY created_at;`
- **Candidates inserted:** `SELECT * FROM candidates WHERE canonical_day = '2025-02-10' ORDER BY created_at DESC;`
- **Email queue:** `SELECT * FROM email_queue WHERE run_id = '<run_id>';`

## Step 5: Set Up pg_cron (Daily Automation)

In Supabase SQL Editor, enable the pg_cron extension and schedule the daily run:

```sql
-- Enable pg_cron (if not already)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily at 00:30 UTC (2:30 AM SAST)
SELECT cron.schedule(
  'daily-cv-processing',
  '30 0 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/process-candidates',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

**Note:** You may need to enable the `pg_net` extension too for HTTP calls from pg_cron.

## Step 6: Parallel Testing (Recommended)

Run **both** systems in parallel for 3-5 days:

1. Keep n8n running as-is
2. The new system's dedup check prevents double-inserts
3. Compare daily:
   ```sql
   -- What n8n inserted today
   SELECT candidate_name, source_email, created_at
   FROM candidates
   WHERE canonical_day = CURRENT_DATE
   AND ai_notes NOT LIKE '%Amalfi%'
   ORDER BY created_at;

   -- What the new system inserted today
   SELECT candidate_name, source_email, created_at
   FROM candidates
   WHERE canonical_day = CURRENT_DATE
   AND ai_notes LIKE '%Amalfi%'
   ORDER BY created_at;
   ```
4. Check the audit log for rejected candidates:
   ```sql
   SELECT candidate_name, stage, action, reason
   FROM pipeline_audit_log
   WHERE action = 'reject'
   AND created_at > CURRENT_DATE
   ORDER BY created_at;
   ```
5. Once confident, disable n8n

## Monitoring

### Quick Health Check
```sql
SELECT
  target_day,
  status,
  emails_fetched,
  candidates_inserted,
  candidates_rejected,
  candidates_duplicates,
  errors_count,
  duration_ms
FROM processing_runs
ORDER BY started_at DESC
LIMIT 7;
```

### Rejection Reasons (Last 7 Days)
```sql
SELECT
  reason,
  COUNT(*) as count
FROM pipeline_audit_log
WHERE action = 'reject'
AND created_at > NOW() - INTERVAL '7 days'
GROUP BY reason
ORDER BY count DESC;
```

### Unmatched Institutions (Add as Variants)
```sql
SELECT
  context->>'degree_institution_raw' as institution,
  COUNT(*) as count
FROM pipeline_audit_log
WHERE stage = 'qualification_gate'
AND action = 'flag'
AND reason LIKE '%not found in sa_university_variants%'
AND created_at > NOW() - INTERVAL '30 days'
GROUP BY context->>'degree_institution_raw'
ORDER BY count DESC;
```

## Cost Estimate

- Claude Haiku: ~$0.002 per CV, ~$3/month for 1,500 CVs
- No PDFco cost (Claude reads PDFs natively)
- Supabase: within standard plan limits
