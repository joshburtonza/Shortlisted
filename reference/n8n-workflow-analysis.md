# n8n Workflow Analysis — What It Does & What's Broken

## Current Pipeline (n8n)

```
Gmail Trigger (2:30AM SAST daily)
→ Code: Build Gmail query (yesterday's inbox, has:attachment, AGGRESSIVE filename filters)
→ List Messages → Get Message (download attachments)
→ Explode Attachments
→ Code: Filename filter (keep CVs, block certificates/transcripts)
→ Split: PDF → PDFco upload/convert/extract | DOC/DOCX → native extract
→ Merge text paths
→ AI Agent (DeepSeek) → parse CV into structured JSON
→ Parse Candidates & Split
→ Extract sender email + date headers
→ Join email → Merge candidates to headers by email/name match
→ Flatten → Merge with date data
→ DB Payload Builder
→ HTTP POST to Supabase edge function (n8n-ingest-candidates)
```

## Bug 1: Missing Candidates (Anje van Niekerk)

**Root cause:** Gmail query-level filename filtering.

The query includes:
```
-filename:("cover letter") 
-filename:(certificate cert transcript diploma degree sace pgce tefl)
```

Anje's CV was named `UAE CV Anje Cover Letter.pdf`. The `-filename:("cover letter")` filter killed it at the Gmail API level — the email was never even downloaded.

**Additional aggressive filters:**
- MIN_BYTES = 40KB (drops lightweight CVs)
- MAX_BYTES = 6MB
- MAX_KEEP_PER_MESSAGE = 2 (if 3+ attachments, a CV could get dropped)

**Impact:** Any SA teacher with "cover letter", "degree", "diploma", "pgce", "sace", or "certificate" in their filename is invisible. These are extremely common words in SA teacher CV filenames.

## Bug 2: Fake Candidates (John Smith, Sarah Johnson)

**Root cause:** DeepSeek hallucinations.

When DeepSeek receives garbled text (from failed PDF extraction) or empty input, it fabricates plausible-looking candidate records instead of returning empty results.

**No validation step** catches AI fabrications before database insert. The system trusts whatever the AI returns.

**Known fakes:** John Smith, Sarah Johnson — both appeared on the dashboard as real candidates.

## Bug 3: Unqualified Candidates Getting Through (Dewan, Thuraya)

**Root cause:** No qualification enforcement anywhere in the pipeline.

The AI prompt explicitly says: *"You do not decide accept/reject. The database will do final scoring and gating."*

But the database scoring view (`candidate_scored`) only SCORES — it doesn't GATE. The dashboard shows everyone who gets inserted, regardless of score.

**Specific cases:**
- Dewan: Insufficient teaching experience for the role
- Thuraya: Has a diploma only, not a degree (client requires degrees from SA tertiary institutions)
- BA+HDE candidate: Passed when qualification rules should have caught it

## Bug 4: Fragile Email-to-Candidate Join

The n8n workflow tries to match parsed candidates back to their source email using:
1. Email matching (if AI extracted an email that matches the sender)
2. Name matching fallback (only needs 1 token match — highly prone to errors)

If this join fails, candidates get orphaned or assigned wrong metadata (wrong sender email, wrong date).

## Bug 5: No Audit Trail

Debug logging consists of hardcoded checks for "Christine Ferreira" — left over from a previous debugging session. There's no systematic way to trace:
- Which emails were processed
- Which attachments were downloaded
- Why a candidate was accepted/rejected
- Whether a candidate was a duplicate

## Bug 6: Deduplication Gaps

The Supabase edge function (`n8n-ingest-candidates`) has a 24-hour dedup check by email OR name. But:
- Same person applying from different email addresses creates duplicates
- Same person on different days creates duplicates
- No dedup within n8n itself — if the AI extracts the same person twice from different attachments in the same email, both get sent to Supabase

## Performance Stats

- ~50 candidates processed per day
- ~3 dropped (94% delivery rate)
- But quality of delivered candidates is poor (fakes + unqualified + missing real ones)
- DeepSeek cost: <$2 total over 4 months (extremely cheap, extremely unreliable)
- PDFco: separate subscription cost for PDF text extraction

## What The New System Must Fix

1. NO filename filtering — download everything, let AI decide if it's a CV
2. Claude Haiku instead of DeepSeek — reliable extraction, native PDF reading (eliminates PDFco)
3. Hard qualification gate in code — not AI opinions, not dashboard-level filtering
4. Hallucination blocklist — known fake names rejected before DB insert
5. Full audit log — every email, every attachment, every candidate, every decision with reason
6. Idempotent email processing — never process the same Gmail message twice
7. Multi-tenant ready — reads routes from `inbound_email_routes`, not hardcoded IDs
