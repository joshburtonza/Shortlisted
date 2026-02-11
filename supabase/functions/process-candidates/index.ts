// ============================================================================
// process-candidates/index.ts
// Amalfi CV Processor — Supabase Edge Function
//
// Replaces n8n workflow: fetches emails from Gmail, extracts candidate data
// using Claude Haiku, applies qualification business rules, and inserts
// passing candidates into the Supabase candidates table.
//
// Trigger: pg_cron daily at 00:30 UTC (2:30AM SAST) or manual POST
// POST body (optional): { "target_day": "2025-02-10" }
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";

// ============================================================================
// Types
// ============================================================================

interface Route {
  id: string;
  source_email: string;
  user_id: string;
  organization_id: string;
  inbox_tz_id: string;
}

interface ProcessingRun {
  id: string;
  routes_processed: number;
  emails_fetched: number;
  attachments_total: number;
  attachments_processed: number;
  attachments_skipped: number;
  candidates_extracted: number;
  candidates_inserted: number;
  candidates_rejected: number;
  candidates_duplicates: number;
  ai_calls_made: number;
  errors_count: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload: GmailPayload;
  internalDate: string;
}

interface GmailPayload {
  headers: Array<{ name: string; value: string }>;
  parts?: GmailPart[];
  mimeType: string;
  body?: { attachmentId?: string; size: number; data?: string };
  filename?: string;
}

interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
}

interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  data?: string; // base64-encoded content
}

interface CandidateExtraction {
  candidate_name: string;
  email_address?: string;
  contact_number?: string;
  educational_qualifications_raw?: string;
  degree_institution_raw?: string;
  degree_country_raw?: string;
  has_education_degree: boolean;
  qualification_type: string;
  years_teaching_experience: number;
  teaching_phase_specialisation?: string;
  teaching_phase_alignment: string;
  has_tefl: boolean;
  has_tesol: boolean;
  has_celta: boolean;
  countries_raw?: string[];
  current_location_raw?: string;
  raw_ai_score: number;
  ai_notes?: string;
}

interface ClaudeResponse {
  candidates: CandidateExtraction[];
}

interface AuditEntry {
  run_id: string;
  email_queue_id?: string;
  organization_id: string;
  user_id?: string;
  stage: string;
  action: string;
  reason?: string;
  context?: Record<string, unknown>;
  candidate_id?: string;
  candidate_name?: string;
}

// ============================================================================
// Constants
// ============================================================================

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "text/rtf",
]);

const ALLOWED_EXTENSIONS = new Set(["pdf", "doc", "docx", "rtf"]);

const BLOCKED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "bmp", "tiff",
  "mp3", "mp4", "avi", "mov", "wmv", "wav", "flac",
  "zip", "rar", "7z", "tar", "gz",
  "exe", "msi", "bat", "cmd", "sh",
  "xls", "xlsx", "csv", "ppt", "pptx",
]);

const MIN_ATTACHMENT_SIZE = 5 * 1024;       // 5 KB
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024; // 15 MB

// Known AI hallucination / placeholder names
const HALLUCINATED_NAMES = new Set([
  "john smith",
  "jane doe",
  "john doe",
  "jane smith",
  "sarah johnson",
  "test candidate",
  "sample candidate",
  "example candidate",
  "test user",
  "sample user",
  "john test",
  "jane test",
  "candidate name",
  "full name",
  "your name",
  "first last",
  "firstname lastname",
]);

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// ============================================================================
// Gmail API Helper
// ============================================================================

class GmailClient {
  private accessToken: string | null = null;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;

  constructor() {
    this.clientId = Deno.env.get("GMAIL_CLIENT_ID") || "";
    this.clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET") || "";
    this.refreshToken = Deno.env.get("GMAIL_REFRESH_TOKEN") || "";
  }

  async ensureAccessToken(): Promise<void> {
    if (this.accessToken) return;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail OAuth refresh failed: ${response.status} — ${text}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
  }

  async listMessages(query: string): Promise<Array<{ id: string; threadId: string }>> {
    await this.ensureAccessToken();
    const allMessages: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;

    do {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gmail list messages failed: ${response.status} — ${text}`);
      }

      const data = await response.json();
      if (data.messages) {
        allMessages.push(...data.messages);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return allMessages;
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    await this.ensureAccessToken();
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail get message failed: ${response.status} — ${text}`);
    }

    return await response.json();
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<string> {
    await this.ensureAccessToken();
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail get attachment failed: ${response.status} — ${text}`);
    }

    const data = await response.json();
    return data.data; // base64url-encoded
  }
}

// ============================================================================
// Claude AI Helper
// ============================================================================

async function extractCandidateWithClaude(
  attachmentBase64: string,
  mimeType: string,
  filename: string,
  anthropicApiKey: string,
): Promise<ClaudeResponse> {
  // Convert base64url (Gmail format) to standard base64
  const standardBase64 = attachmentBase64
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  // Map mime type to Claude's expected media types
  let mediaType = mimeType;
  if (mimeType === "application/msword" || mimeType === "application/rtf" || mimeType === "text/rtf") {
    // For DOC/RTF, we still send as-is — Claude handles document types
    mediaType = mimeType;
  }

  const systemPrompt = `You are a CV parsing assistant for a South African teacher recruitment agency. Your job is to determine if a document is a CV/resume and, if so, extract structured candidate data.

CRITICAL RULES:
1. Return ONLY valid JSON. No markdown, no explanation, no preamble.
2. If the document is NOT a CV (e.g., cover letter, certificate, transcript, reference letter, ID document), return exactly: {"candidates": []}
3. NEVER fabricate or invent candidate data. If information is not present in the document, use null or appropriate defaults.
4. Extract ALL information visible in the document. Do not summarize or omit details.
5. A document contains exactly 0 or 1 candidates. Never return more than 1 candidate per document.

EXTRACTION FIELDS (return these for each candidate):
{
  "candidates": [{
    "candidate_name": "Full name, no titles (Mr/Mrs/Dr) — string, required",
    "email_address": "Email from CV — string or null",
    "contact_number": "Phone number — string or null",
    "educational_qualifications_raw": "ALL qualifications listed verbatim, semicolon-separated — string",
    "degree_institution_raw": "University/institution of their education/teaching degree — string or null",
    "degree_country_raw": "Country of that institution — string or null",
    "has_education_degree": "true if they have BEd, BA Education, BSc Education, BCom Education, PGCE+degree, or HDE. false for diploma-only, certificate-only, or studying. — boolean",
    "qualification_type": "One of: BEd, BA_Education, BSc_Education, BCom_Education, PGCE, HDE, Diploma, Certificate, Other, Unknown — string",
    "years_teaching_experience": "Total years of teaching experience. Estimate from employment dates if not stated explicitly. 0 if unknown or student. — number",
    "teaching_phase_specialisation": "One of: Foundation, Intermediate, Senior, FET, Multiple, Unknown — string",
    "teaching_phase_alignment": "One of: aligned, partial, not_aligned, unknown — based on whether their qualification matches the phase they teach — string",
    "has_tefl": "boolean",
    "has_tesol": "boolean",
    "has_celta": "boolean",
    "countries_raw": "Array of countries mentioned (nationality, work history, education) — string[]",
    "current_location_raw": "Current city/country — string or null",
    "raw_ai_score": "0-100 holistic score: 80+ = strong SA-qualified teacher, 50-79 = qualified but gaps, 30-49 = borderline, <30 = likely unqualified — integer",
    "ai_notes": "1-3 sentences explaining the score — string"
  }]
}

SOUTH AFRICAN CONTEXT:
- BEd = Bachelor of Education (4 years)
- PGCE = Postgraduate Certificate in Education (1 year, requires underlying degree)
- HDE = Higher Diploma in Education (legacy qualification, treat as degree-equivalent)
- Foundation Phase = Grades R-3, Intermediate = Grades 4-6, Senior = Grades 7-9, FET = Grades 10-12
- SACE = South African Council for Educators (registration, not a qualification)
- Common SA universities: UCT, Wits, UP, Stellenbosch, UNISA, NWU, UJ, UFS, UKZN, Rhodes, Nelson Mandela, etc.`;

  const content: Array<Record<string, unknown>> = [];

  // For PDFs, send as document type (Claude reads natively)
  if (mimeType === "application/pdf") {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: standardBase64,
      },
    });
  } else {
    // For DOC/DOCX/RTF, also send as base64 document
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: mediaType,
        data: standardBase64,
      },
    });
  }

  content.push({
    type: "text",
    text: `Parse this document (filename: "${filename}"). Return ONLY the JSON object as specified. If this is not a CV/resume, return {"candidates": []}.`,
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${text}`);
  }

  const result = await response.json();
  const textContent = result.content?.find(
    (c: { type: string }) => c.type === "text",
  );

  if (!textContent?.text) {
    throw new Error("Claude returned no text content");
  }

  // Parse the JSON response (Claude sometimes wraps in markdown code blocks)
  let jsonStr = textContent.text.trim();
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.slice(7);
  }
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.slice(3);
  }
  if (jsonStr.endsWith("```")) {
    jsonStr = jsonStr.slice(0, -3);
  }
  jsonStr = jsonStr.trim();

  const parsed = JSON.parse(jsonStr) as ClaudeResponse;

  // Safety: ensure structure
  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
    return { candidates: [] };
  }

  return parsed;
}

// ============================================================================
// Business Rules: Qualification Gate
// ============================================================================

interface GateResult {
  pass: boolean;
  action: "pass" | "reject" | "flag";
  reason: string;
  flags: string[];
}

async function applyQualificationGate(
  candidate: CandidateExtraction,
  supabase: SupabaseClient,
): Promise<GateResult> {
  const flags: string[] = [];

  // ---- GATE 1: Must have education degree ----
  if (!candidate.has_education_degree) {
    return {
      pass: false,
      action: "reject",
      reason: `No education degree. qualification_type=${candidate.qualification_type}`,
      flags,
    };
  }

  // Check qualification type isn't diploma/certificate only
  const qualType = (candidate.qualification_type || "Unknown").toLowerCase();
  if (qualType === "diploma" || qualType === "certificate") {
    return {
      pass: false,
      action: "reject",
      reason: `Qualification is ${candidate.qualification_type} only, not a degree`,
      flags,
    };
  }

  // ---- GATE 2: Must have South Africa connection ----
  const hasSACountry = (candidate.countries_raw || []).some(
    (c) => /south\s*africa|^sa$|^rsa$/i.test(c),
  );
  const hasSADegreeCountry = /south\s*africa/i.test(
    candidate.degree_country_raw || "",
  );
  const hasSALocation = /south\s*africa|johannesburg|cape\s*town|pretoria|durban|bloemfontein|port\s*elizabeth|east\s*london|polokwane|nelspruit|pietermaritzburg|kimberley|rustenburg|soweto|centurion|sandton|stellenbosch|george|knysna|umhlanga/i.test(
    candidate.current_location_raw || "",
  );

  // Also check if degree institution is a known SA university (this counts as SA connection)
  let hasSAInstitution = false;
  if (candidate.degree_institution_raw) {
    const instNorm = candidate.degree_institution_raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
    const { data: uniMatch } = await supabase
      .from("sa_university_variants")
      .select("canonical_university")
      .ilike("norm_variant", `%${instNorm}%`)
      .limit(1);
    if (uniMatch && uniMatch.length > 0) {
      hasSAInstitution = true;
    }
  }

  if (!hasSACountry && !hasSADegreeCountry && !hasSALocation && !hasSAInstitution) {
    return {
      pass: false,
      action: "reject",
      reason: `No South Africa connection found. countries=${JSON.stringify(candidate.countries_raw)}, degree_country=${candidate.degree_country_raw}, location=${candidate.current_location_raw}, institution=${candidate.degree_institution_raw}`,
      flags,
    };
  }

  // ---- GATE 3: Degree from registered SA institution ----
  // This is a SOFT gate per business-rules.md — flag but don't hard-reject
  // because the variant list may be incomplete
  if (candidate.degree_institution_raw && !hasSAInstitution) {
    // Re-check with a broader match
    const instNorm = candidate.degree_institution_raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
    const { data: broadMatch } = await supabase
      .from("sa_university_variants")
      .select("canonical_university, variant")
      .ilike("norm_variant", `%${instNorm}%`)
      .limit(1);

    if (!broadMatch || broadMatch.length === 0) {
      flags.push(
        `Institution "${candidate.degree_institution_raw}" not found in sa_university_variants — may need new variant added`,
      );
    }
  }

  // ---- SOFT SIGNALS ----
  if (candidate.years_teaching_experience < 1) {
    flags.push("Less than 1 year experience — may be student or new graduate");
  } else if (candidate.years_teaching_experience < 2) {
    flags.push("Limited experience (< 2 years)");
  }

  return {
    pass: true,
    action: flags.length > 0 ? "flag" : "pass",
    reason: flags.length > 0
      ? `Passed with flags: ${flags.join("; ")}`
      : "Passed all qualification gates",
    flags,
  };
}

// ============================================================================
// Hallucination Check
// ============================================================================

function isHallucinatedCandidate(name: string): boolean {
  if (!name) return true;
  const normalized = name.toLowerCase().trim();
  if (HALLUCINATED_NAMES.has(normalized)) return true;
  // Check for very short / generic names
  if (normalized.length < 3) return true;
  // Check for placeholder patterns
  if (/^(test|sample|example|dummy|fake|placeholder)\b/i.test(normalized)) return true;
  if (/^(candidate|applicant|person|user)\s*(name|[0-9])?$/i.test(normalized)) return true;
  return false;
}

// ============================================================================
// Attachment Filtering
// ============================================================================

function getFileExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

function isAllowedAttachment(
  filename: string,
  mimeType: string,
  size: number,
): { allowed: boolean; reason: string } {
  // Size checks
  if (size < MIN_ATTACHMENT_SIZE) {
    return { allowed: false, reason: `File too small: ${size} bytes (min ${MIN_ATTACHMENT_SIZE})` };
  }
  if (size > MAX_ATTACHMENT_SIZE) {
    return { allowed: false, reason: `File too large: ${size} bytes (max ${MAX_ATTACHMENT_SIZE})` };
  }

  // Check by extension first
  const ext = getFileExtension(filename);
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `Blocked extension: .${ext}` };
  }

  // Check by MIME type
  if (ALLOWED_MIME_TYPES.has(mimeType)) {
    return { allowed: true, reason: "Allowed by MIME type" };
  }

  // Check by extension if MIME type is generic (e.g., "application/octet-stream")
  if (ext && ALLOWED_EXTENSIONS.has(ext)) {
    return { allowed: true, reason: `Allowed by extension: .${ext}` };
  }

  // Default: block unknown types
  return { allowed: false, reason: `Unknown type: ${mimeType} / .${ext}` };
}

// ============================================================================
// Helper: Extract attachments from Gmail message parts (recursive)
// ============================================================================

function extractAttachmentParts(parts: GmailPart[] | undefined): Attachment[] {
  const attachments: Attachment[] = [];
  if (!parts) return attachments;

  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size,
        attachmentId: part.body.attachmentId,
      });
    }
    // Recurse into nested parts (multipart messages)
    if (part.parts) {
      attachments.push(...extractAttachmentParts(part.parts));
    }
  }

  return attachments;
}

// ============================================================================
// Helper: Get email header value
// ============================================================================

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value || "";
}

// ============================================================================
// Audit Logger
// ============================================================================

async function auditLog(
  supabase: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  try {
    await supabase.from("pipeline_audit_log").insert({
      run_id: entry.run_id,
      email_queue_id: entry.email_queue_id,
      organization_id: entry.organization_id,
      user_id: entry.user_id,
      stage: entry.stage,
      action: entry.action,
      reason: entry.reason,
      context: entry.context || {},
      candidate_id: entry.candidate_id,
      candidate_name: entry.candidate_name,
    });
  } catch (err) {
    // Never let audit logging crash the pipeline
    console.error("Audit log insert failed:", err);
  }
}

// ============================================================================
// Helper: Get target day date range for Gmail query
// ============================================================================

function getTargetDayRange(targetDay: string, tzId: string): { after: number; before: number } {
  // targetDay is "YYYY-MM-DD"
  // We need to convert the day boundaries in the given timezone to Unix timestamps
  // Gmail after/before uses midnight UTC, but we want SAST boundaries
  // Use Date parsing with timezone offset

  // Simple approach: parse as UTC start-of-day, then adjust for timezone
  // Africa/Johannesburg is UTC+2
  const tzOffsets: Record<string, number> = {
    "Africa/Johannesburg": 2,
    "UTC": 0,
  };
  const offsetHours = tzOffsets[tzId] ?? 2; // Default to SAST

  const dayStart = new Date(`${targetDay}T00:00:00Z`);
  dayStart.setUTCHours(dayStart.getUTCHours() - offsetHours);

  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  return {
    after: Math.floor(dayStart.getTime() / 1000),
    before: Math.floor(dayEnd.getTime() / 1000),
  };
}

// ============================================================================
// Helper: Canonical day from email date in SA timezone
// ============================================================================

function deriveCanonicalDay(emailDate: string | Date): string {
  const date = typeof emailDate === "string" ? new Date(emailDate) : emailDate;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date); // "YYYY-MM-DD"
}

// ============================================================================
// Main Pipeline
// ============================================================================

async function processRoute(
  route: Route,
  targetDay: string,
  runId: string,
  gmail: GmailClient,
  supabase: SupabaseClient,
  anthropicApiKey: string,
  stats: ProcessingRun,
): Promise<void> {
  const { after, before } = getTargetDayRange(targetDay, route.inbox_tz_id);

  // Gmail query: emails with attachments from target day — NO filename filtering
  const query = `in:inbox has:attachment after:${after} before:${before}`;
  console.log(`[Route ${route.source_email}] Gmail query: ${query}`);

  let messages: Array<{ id: string; threadId: string }>;
  try {
    messages = await gmail.listMessages(query);
  } catch (err) {
    console.error(`[Route ${route.source_email}] Gmail list error:`, err);
    await auditLog(supabase, {
      run_id: runId,
      organization_id: route.organization_id,
      user_id: route.user_id,
      stage: "email_fetched",
      action: "error",
      reason: `Gmail API error: ${(err as Error).message}`,
    });
    stats.errors_count++;
    return;
  }

  console.log(`[Route ${route.source_email}] Found ${messages.length} messages for ${targetDay}`);

  for (const msgRef of messages) {
    try {
      await processMessage(
        msgRef.id,
        route,
        runId,
        gmail,
        supabase,
        anthropicApiKey,
        stats,
      );
    } catch (err) {
      console.error(`[Message ${msgRef.id}] Unexpected error:`, err);
      stats.errors_count++;
      await auditLog(supabase, {
        run_id: runId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "error",
        action: "error",
        reason: `Unhandled error processing message ${msgRef.id}: ${(err as Error).message}`,
        context: { gmail_message_id: msgRef.id },
      });
    }
  }
}

async function processMessage(
  messageId: string,
  route: Route,
  runId: string,
  gmail: GmailClient,
  supabase: SupabaseClient,
  anthropicApiKey: string,
  stats: ProcessingRun,
): Promise<void> {
  // ---- Idempotency check: already in email_queue? ----
  const { data: existingEmail } = await supabase
    .from("email_queue")
    .select("id, status")
    .eq("gmail_message_id", messageId)
    .eq("organization_id", route.organization_id)
    .limit(1);

  if (existingEmail && existingEmail.length > 0) {
    console.log(`[Message ${messageId}] Already in email_queue (status: ${existingEmail[0].status}), skipping`);
    return;
  }

  // ---- Fetch full message ----
  const message = await gmail.getMessage(messageId);
  const headers = message.payload.headers;
  const senderEmail = getHeader(headers, "From");
  const subject = getHeader(headers, "Subject");
  const emailDateStr = getHeader(headers, "Date");
  const emailDate = emailDateStr ? new Date(emailDateStr) : new Date(parseInt(message.internalDate));

  // Extract attachments from parts
  const attachments = extractAttachmentParts(message.payload.parts);

  // ---- Insert into email_queue ----
  const { data: emailQueueRow, error: eqError } = await supabase
    .from("email_queue")
    .insert({
      run_id: runId,
      organization_id: route.organization_id,
      user_id: route.user_id,
      route_id: route.id,
      gmail_message_id: messageId,
      gmail_thread_id: message.threadId,
      sender_email: senderEmail,
      subject: subject,
      email_date: emailDate.toISOString(),
      attachment_count: attachments.length,
      status: "processing",
    })
    .select()
    .single();

  if (eqError) {
    // Likely a unique constraint violation (race condition) — skip
    console.log(`[Message ${messageId}] email_queue insert error (likely dupe): ${eqError.message}`);
    return;
  }

  const emailQueueId = emailQueueRow.id;
  stats.emails_fetched++;

  await auditLog(supabase, {
    run_id: runId,
    email_queue_id: emailQueueId,
    organization_id: route.organization_id,
    user_id: route.user_id,
    stage: "email_fetched",
    action: "info",
    reason: `Fetched email: "${subject}" from ${senderEmail}`,
    context: {
      gmail_message_id: messageId,
      subject,
      sender: senderEmail,
      email_date: emailDate.toISOString(),
      attachment_count: attachments.length,
    },
  });

  if (attachments.length === 0) {
    await supabase
      .from("email_queue")
      .update({ status: "skipped", processed_at: new Date().toISOString() })
      .eq("id", emailQueueId);
    return;
  }

  let anyProcessed = false;

  // ---- Process each attachment ----
  for (const attachment of attachments) {
    stats.attachments_total++;

    const filterResult = isAllowedAttachment(
      attachment.filename,
      attachment.mimeType,
      attachment.size,
    );

    if (!filterResult.allowed) {
      stats.attachments_skipped++;
      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "attachment_skipped",
        action: "skip",
        reason: filterResult.reason,
        context: {
          filename: attachment.filename,
          mime_type: attachment.mimeType,
          size: attachment.size,
        },
      });
      continue;
    }

    await auditLog(supabase, {
      run_id: runId,
      email_queue_id: emailQueueId,
      organization_id: route.organization_id,
      user_id: route.user_id,
      stage: "attachment_downloaded",
      action: "info",
      reason: `Downloading: ${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)`,
      context: {
        filename: attachment.filename,
        mime_type: attachment.mimeType,
        size: attachment.size,
      },
    });

    // ---- Download attachment content ----
    let attachmentData: string;
    try {
      attachmentData = await gmail.getAttachment(messageId, attachment.attachmentId);
    } catch (err) {
      stats.errors_count++;
      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "attachment_downloaded",
        action: "error",
        reason: `Failed to download: ${(err as Error).message}`,
        context: { filename: attachment.filename },
      });
      continue;
    }

    stats.attachments_processed++;
    anyProcessed = true;

    // ---- Send to Claude Haiku ----
    let claudeResult: ClaudeResponse;
    try {
      stats.ai_calls_made++;
      claudeResult = await extractCandidateWithClaude(
        attachmentData,
        attachment.mimeType,
        attachment.filename,
        anthropicApiKey,
      );
    } catch (err) {
      stats.errors_count++;
      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "ai_error",
        action: "error",
        reason: `Claude API error: ${(err as Error).message}`,
        context: { filename: attachment.filename },
      });
      continue;
    }

    // ---- Not a CV? ----
    if (claudeResult.candidates.length === 0) {
      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "ai_not_cv",
        action: "skip",
        reason: `Claude determined this is not a CV`,
        context: { filename: attachment.filename },
      });
      continue;
    }

    await auditLog(supabase, {
      run_id: runId,
      email_queue_id: emailQueueId,
      organization_id: route.organization_id,
      user_id: route.user_id,
      stage: "ai_extraction",
      action: "pass",
      reason: `Extracted ${claudeResult.candidates.length} candidate(s)`,
      context: {
        filename: attachment.filename,
        candidate_names: claudeResult.candidates.map((c) => c.candidate_name),
      },
    });

    // ---- Process each extracted candidate ----
    for (const candidate of claudeResult.candidates) {
      stats.candidates_extracted++;

      // ---- Hallucination check ----
      if (isHallucinatedCandidate(candidate.candidate_name)) {
        stats.candidates_rejected++;
        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "hallucination_check",
          action: "reject",
          reason: `Suspected hallucinated/placeholder name: "${candidate.candidate_name}"`,
          candidate_name: candidate.candidate_name,
          context: { filename: attachment.filename },
        });
        continue;
      }

      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "hallucination_check",
        action: "pass",
        reason: "Name passes hallucination check",
        candidate_name: candidate.candidate_name,
      });

      // ---- Qualification gate ----
      const gateResult = await applyQualificationGate(candidate, supabase);

      if (!gateResult.pass) {
        stats.candidates_rejected++;
        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "qualification_gate",
          action: "reject",
          reason: gateResult.reason,
          candidate_name: candidate.candidate_name,
          context: {
            has_education_degree: candidate.has_education_degree,
            qualification_type: candidate.qualification_type,
            degree_institution_raw: candidate.degree_institution_raw,
            degree_country_raw: candidate.degree_country_raw,
            countries_raw: candidate.countries_raw,
            current_location_raw: candidate.current_location_raw,
          },
        });

        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "candidate_rejected",
          action: "reject",
          reason: gateResult.reason,
          candidate_name: candidate.candidate_name,
        });
        continue;
      }

      // Log flags (soft signals) if any
      if (gateResult.flags.length > 0) {
        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "qualification_gate",
          action: "flag",
          reason: gateResult.reason,
          candidate_name: candidate.candidate_name,
          context: { flags: gateResult.flags },
        });
      } else {
        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "qualification_gate",
          action: "pass",
          reason: gateResult.reason,
          candidate_name: candidate.candidate_name,
        });
      }

      // ---- Deduplication check (24h window) ----
      const twentyFourHoursAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();

      let dupeQuery = supabase
        .from("candidates")
        .select("id, candidate_name, email_address, created_at")
        .eq("organization_id", route.organization_id)
        .gte("created_at", twentyFourHoursAgo);

      if (candidate.email_address && candidate.email_address.trim()) {
        dupeQuery = dupeQuery.ilike(
          "email_address",
          candidate.email_address.trim(),
        );
      } else {
        dupeQuery = dupeQuery.ilike(
          "candidate_name",
          candidate.candidate_name.trim(),
        );
      }

      const { data: existingDupes } = await dupeQuery.limit(1);

      if (existingDupes && existingDupes.length > 0) {
        stats.candidates_duplicates++;
        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "dedup_check",
          action: "skip",
          reason: `Duplicate: matches existing candidate ${existingDupes[0].id}`,
          candidate_name: candidate.candidate_name,
          context: {
            existing_id: existingDupes[0].id,
            existing_name: existingDupes[0].candidate_name,
            match_by: candidate.email_address ? "email" : "name",
          },
        });

        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "candidate_skipped",
          action: "skip",
          reason: "Duplicate within 24-hour window",
          candidate_name: candidate.candidate_name,
        });
        continue;
      }

      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "dedup_check",
        action: "pass",
        reason: "No duplicate found",
        candidate_name: candidate.candidate_name,
      });

      // ---- Normalize degree institution ----
      const degreeNorm = candidate.degree_institution_raw
        ? candidate.degree_institution_raw
            .toLowerCase()
            .replace(/[^a-zA-Z0-9]+/g, " ")
            .trim()
        : null;

      // ---- Derive canonical day from email date ----
      const canonicalDay = deriveCanonicalDay(emailDate);

      // ---- INSERT into candidates table ----
      const { data: inserted, error: insertError } = await supabase
        .from("candidates")
        .insert({
          user_id: route.user_id,
          organization_id: route.organization_id,
          source_email: route.source_email,
          canonical_day: canonicalDay,
          date_received: emailDate.toISOString(),
          candidate_name: candidate.candidate_name,
          email_address: candidate.email_address || null,
          contact_number: candidate.contact_number || null,
          educational_qualifications_raw:
            candidate.educational_qualifications_raw || null,
          degree_institution_raw: candidate.degree_institution_raw || null,
          degree_country_raw: candidate.degree_country_raw || null,
          degree_institution_norm: degreeNorm,
          has_education_degree: candidate.has_education_degree,
          qualification_type: candidate.qualification_type || "Unknown",
          years_teaching_experience: candidate.years_teaching_experience || 0,
          teaching_phase_specialisation:
            candidate.teaching_phase_specialisation || "Unknown",
          teaching_phase_alignment:
            candidate.teaching_phase_alignment || "unknown",
          has_tefl: candidate.has_tefl || false,
          has_tesol: candidate.has_tesol || false,
          has_celta: candidate.has_celta || false,
          countries_raw: candidate.countries_raw || [],
          current_location_raw: candidate.current_location_raw || null,
          raw_ai_score: candidate.raw_ai_score || 0,
          ai_notes: candidate.ai_notes || null,
        })
        .select()
        .single();

      if (insertError) {
        stats.errors_count++;
        await auditLog(supabase, {
          run_id: runId,
          email_queue_id: emailQueueId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "candidate_inserted",
          action: "error",
          reason: `Insert failed: ${insertError.message}`,
          candidate_name: candidate.candidate_name,
        });
        continue;
      }

      stats.candidates_inserted++;
      console.log(`✓ Inserted: ${candidate.candidate_name} (${inserted.id})`);

      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "candidate_inserted",
        action: "pass",
        reason: "Successfully inserted into candidates table",
        candidate_id: inserted.id,
        candidate_name: candidate.candidate_name,
        context: {
          qualification_type: candidate.qualification_type,
          has_education_degree: candidate.has_education_degree,
          years_experience: candidate.years_teaching_experience,
          raw_ai_score: candidate.raw_ai_score,
        },
      });
    }
  }

  // ---- Update email_queue status ----
  await supabase
    .from("email_queue")
    .update({
      status: anyProcessed ? "completed" : "skipped",
      processed_at: new Date().toISOString(),
    })
    .eq("id", emailQueueId);
}

// ============================================================================
// Entry Point
// ============================================================================

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // ---- Parse request ----
    let targetDay: string;
    try {
      const body = await req.json();
      targetDay = body.target_day;
    } catch {
      // No body or invalid JSON — default to yesterday
      targetDay = "";
    }

    if (!targetDay) {
      // Default: yesterday in SAST
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      targetDay = deriveCanonicalDay(yesterday);
    }

    console.log(`=== Processing candidates for ${targetDay} ===`);

    // ---- Initialize clients ----
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const gmail = new GmailClient();

    // ---- Create processing run ----
    const { data: run, error: runError } = await supabase
      .from("processing_runs")
      .insert({
        target_day: targetDay,
        status: "running",
        triggered_by: "manual", // TODO: detect cron vs manual
      })
      .select()
      .single();

    if (runError) {
      throw new Error(`Failed to create processing run: ${runError.message}`);
    }

    const runId = run.id;
    const stats: ProcessingRun = {
      id: runId,
      routes_processed: 0,
      emails_fetched: 0,
      attachments_total: 0,
      attachments_processed: 0,
      attachments_skipped: 0,
      candidates_extracted: 0,
      candidates_inserted: 0,
      candidates_rejected: 0,
      candidates_duplicates: 0,
      ai_calls_made: 0,
      errors_count: 0,
    };

    // ---- Fetch all routes ----
    const { data: routes, error: routesError } = await supabase
      .from("inbound_email_routes")
      .select("id, source_email, user_id, organization_id, inbox_tz_id");

    if (routesError) {
      throw new Error(`Failed to fetch routes: ${routesError.message}`);
    }

    console.log(`Found ${routes?.length || 0} routes to process`);

    // ---- Process each route ----
    for (const route of routes || []) {
      stats.routes_processed++;
      console.log(`\n--- Processing route: ${route.source_email} ---`);

      try {
        await processRoute(
          route as Route,
          targetDay,
          runId,
          gmail,
          supabase,
          anthropicApiKey,
          stats,
        );
      } catch (err) {
        console.error(`[Route ${route.source_email}] Fatal error:`, err);
        stats.errors_count++;
        await auditLog(supabase, {
          run_id: runId,
          organization_id: route.organization_id,
          user_id: route.user_id,
          stage: "error",
          action: "error",
          reason: `Route processing failed: ${(err as Error).message}`,
          context: { route_id: route.id, source_email: route.source_email },
        });
      }
    }

    // ---- Finalize processing run ----
    const durationMs = Date.now() - startTime;
    const finalStatus =
      stats.errors_count > 0 ? "completed_with_errors" : "completed";

    await supabase
      .from("processing_runs")
      .update({
        status: finalStatus,
        routes_processed: stats.routes_processed,
        emails_fetched: stats.emails_fetched,
        attachments_total: stats.attachments_total,
        attachments_processed: stats.attachments_processed,
        attachments_skipped: stats.attachments_skipped,
        candidates_extracted: stats.candidates_extracted,
        candidates_inserted: stats.candidates_inserted,
        candidates_rejected: stats.candidates_rejected,
        candidates_duplicates: stats.candidates_duplicates,
        ai_calls_made: stats.ai_calls_made,
        errors_count: stats.errors_count,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      })
      .eq("id", runId);

    console.log(`\n=== Run completed in ${durationMs}ms ===`);
    console.log(`  Routes: ${stats.routes_processed}`);
    console.log(`  Emails: ${stats.emails_fetched}`);
    console.log(`  Attachments: ${stats.attachments_processed}/${stats.attachments_total} processed`);
    console.log(`  Candidates: ${stats.candidates_inserted} inserted, ${stats.candidates_rejected} rejected, ${stats.candidates_duplicates} duplicates`);
    console.log(`  AI calls: ${stats.ai_calls_made}`);
    console.log(`  Errors: ${stats.errors_count}`);

    return new Response(
      JSON.stringify({
        success: true,
        run_id: runId,
        target_day: targetDay,
        status: finalStatus,
        duration_ms: durationMs,
        stats: {
          routes_processed: stats.routes_processed,
          emails_fetched: stats.emails_fetched,
          attachments_total: stats.attachments_total,
          attachments_processed: stats.attachments_processed,
          attachments_skipped: stats.attachments_skipped,
          candidates_extracted: stats.candidates_extracted,
          candidates_inserted: stats.candidates_inserted,
          candidates_rejected: stats.candidates_rejected,
          candidates_duplicates: stats.candidates_duplicates,
          ai_calls_made: stats.ai_calls_made,
          errors_count: stats.errors_count,
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error("Fatal pipeline error:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message,
        duration_ms: durationMs,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});
