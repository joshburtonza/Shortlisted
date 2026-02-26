// ============================================================================
// process-candidates/index.ts
// Amalfi CV Processor — Supabase Edge Function
//
// Multi-tenant rewrite: per-org Gmail OAuth tokens, vertical templates
// (AI prompt + gate rules fetched from DB), universal qualification gate.
// Backward-compatible with Nicole's teaching org (no gmail_token_id, no
// vertical_id — falls back to env secret + teaching prompt + all existing
// teaching columns).
//
// Trigger: pg_cron daily at 00:30 UTC (2:30AM SAST) or manual POST
// POST body (optional): { "target_day": "2025-02-10" }
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";
import { ZipReader, BlobReader, TextWriter } from "https://esm.sh/@zip.js/zip.js@2.7.52";

// ============================================================================
// Types
// ============================================================================

interface GateRule {
  field: string;
  op: "eq" | "ne" | "lt" | "gt";
  value: unknown;
  reason: string;
}

interface GateRules {
  hard?: GateRule[];
  soft?: GateRule[];
}

interface Route {
  id: string;
  source_email: string;
  user_id: string;
  organization_id: string;
  inbox_tz_id: string;
  gmail_token_id?: string;
  // Resolved from organizations + vertical_templates join:
  vertical_name?: string;       // e.g. 'teaching', 'legal', 'tech'
  ai_system_prompt?: string;    // full system prompt (override > template > fallback)
  gate_rules: GateRules;        // always populated (may be empty)
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
  data?: string;
}

// Universal extraction type — all verticals must return these fields.
// Vertical-specific fields are captured by the index signature and stored
// in raw_extraction jsonb. Teaching columns are back-populated via mapTeachingFields().
interface CandidateExtraction {
  candidate_name: string;
  email_address?: string;
  contact_number?: string;
  current_location_raw?: string;
  countries_raw?: string[];
  has_required_qualification: boolean;  // THE single universal gate — set by AI prompt
  years_experience: number;
  raw_ai_score: number;
  ai_notes?: string;
  // All other vertical-specific fields live here (passed through to raw_extraction)
  [key: string]: unknown;
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

interface GateResult {
  pass: boolean;
  action: "pass" | "reject" | "flag";
  reason: string;
  flags: string[];
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

const MIN_ATTACHMENT_SIZE = 5 * 1024;
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;

const HALLUCINATED_NAMES = new Set([
  "john smith", "jane doe", "john doe", "jane smith", "sarah johnson",
  "test candidate", "sample candidate", "example candidate", "test user",
  "sample user", "john test", "jane test", "candidate name", "full name",
  "your name", "first last", "firstname lastname",
]);

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

// Fallback teaching system prompt (used when org has no vertical_id set —
// i.e., Nicole's existing setup). Kept in sync with the teaching vertical_template.
const TEACHING_FALLBACK_PROMPT = `You are a CV parsing assistant for a South African teacher recruitment agency. Your job is to determine if a document is a CV/resume and, if so, extract structured candidate data.

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
    "has_education_degree": "true if they have BEd, BA Education, BSc Education, BCom Education, PGCE+degree, or HDE. false for diploma-only, certificate-only, or studying — boolean",
    "qualification_type": "One of: BEd, BA_Education, BSc_Education, BCom_Education, PGCE, HDE, Diploma, Certificate, Other, Unknown — string",
    "years_teaching_experience": "Total years of teaching experience. Estimate from employment dates if not stated explicitly. 0 if unknown or student — number",
    "years_experience": "Same as years_teaching_experience — number",
    "teaching_phase_specialisation": "One of: Foundation, Intermediate, Senior, FET, Multiple, Unknown — string",
    "teaching_phase_alignment": "One of: aligned, partial, not_aligned, unknown — string",
    "has_tefl": "boolean",
    "has_tesol": "boolean",
    "has_celta": "boolean",
    "countries_raw": "Array of countries mentioned — string[]",
    "current_location_raw": "Current city/country — string or null",
    "has_required_qualification": "true if has_education_degree is true AND the candidate has ANY South Africa connection (South Africa in countries_raw, OR degree_country_raw is South Africa, OR current_location_raw indicates a South African city or country, OR degree_institution_raw is a known South African university). false otherwise — boolean",
    "raw_ai_score": "0-100 holistic score — integer",
    "ai_notes": "1-3 sentences explaining the score — string"
  }]
}

SOUTH AFRICAN CONTEXT:
- BEd = Bachelor of Education (4 years)
- PGCE = Postgraduate Certificate in Education (1 year, requires underlying degree)
- HDE = Higher Diploma in Education (legacy qualification, treat as degree-equivalent)
- Foundation Phase = Grades R-3, Intermediate = Grades 4-6, Senior = Grades 7-9, FET = Grades 10-12
- SACE = South African Council for Educators (registration, not a qualification)
- Known SA universities: UCT, Wits, UP, Stellenbosch, UNISA, NWU, UJ, UFS, UKZN, Rhodes, Nelson Mandela, etc.`;

// ============================================================================
// Gmail: Per-org token resolution
// ============================================================================

async function resolveGmailAccessToken(
  route: Route,
  supabase: SupabaseClient,
): Promise<string> {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET")!;

  if (route.gmail_token_id) {
    // Per-org token path
    const { data: tokenRow, error } = await supabase
      .from("org_gmail_tokens")
      .select("refresh_token, access_token, token_expires_at")
      .eq("id", route.gmail_token_id)
      .single();

    if (error || !tokenRow) {
      throw new Error(`No org Gmail token found for gmail_token_id=${route.gmail_token_id}`);
    }

    // Return cached access token if still valid (with 60s buffer)
    const now = Date.now();
    const expires = tokenRow.token_expires_at ? new Date(tokenRow.token_expires_at).getTime() : 0;
    if (tokenRow.access_token && expires > now + 60_000) {
      return tokenRow.access_token;
    }

    // Refresh the token
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenRow.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Org Gmail token refresh failed: ${resp.status} — ${text}`);
    }

    const tokenData = await resp.json();
    const newAccessToken: string = tokenData.access_token;
    const expiresAt = new Date(now + (tokenData.expires_in || 3600) * 1000).toISOString();

    // Cache the refreshed token
    await supabase.from("org_gmail_tokens").update({
      access_token: newAccessToken,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq("id", route.gmail_token_id);

    return newAccessToken;
  }

  // Fallback: shared env secret (Nicole's existing setup)
  const refreshToken = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail OAuth refresh failed: ${resp.status} — ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ============================================================================
// Gmail API Helper
// ============================================================================

class GmailClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  async listMessages(query: string): Promise<Array<{ id: string; threadId: string }>> {
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
      if (data.messages) allMessages.push(...data.messages);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return allMessages;
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
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
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail get attachment failed: ${response.status} — ${text}`);
    }

    const data = await response.json();
    return data.data;
  }
}

// ============================================================================
// DOCX Text Extraction
// ============================================================================

async function extractTextFromDocx(base64Data: string): Promise<string> {
  try {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "application/zip" });
    const zipReader = new ZipReader(new BlobReader(blob));
    const entries = await zipReader.getEntries();
    const docEntry = entries.find((e) => e.filename === "word/document.xml");

    if (!docEntry || !docEntry.getData) {
      await zipReader.close();
      return "[Could not find document content in DOCX file]";
    }

    const xmlContent = await docEntry.getData(new TextWriter());
    await zipReader.close();

    const text = xmlContent
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return text || "[DOCX file appears to be empty]";
  } catch (err) {
    return `[DOCX text extraction failed: ${(err as Error).message}]`;
  }
}

function extractTextFromDoc(base64Data: string): string {
  try {
    const binaryString = atob(base64Data);
    const MIN_WORD_LENGTH = 2;
    const MAX_OUTPUT_CHARS = 30000;
    const textRuns: string[] = [];
    let currentRun = "";
    let totalChars = 0;

    for (let i = 0; i < binaryString.length && totalChars < MAX_OUTPUT_CHARS; i++) {
      const code = binaryString.charCodeAt(i);
      if (code >= 32 && code < 127) {
        currentRun += binaryString[i];
      } else if ((code === 13 || code === 10) && currentRun.length >= MIN_WORD_LENGTH) {
        currentRun += "\n";
      } else {
        if (currentRun.trim().length >= MIN_WORD_LENGTH) {
          const trimmed = currentRun.trim();
          if (!/^[0-9A-Fa-f\s]{20,}$/.test(trimmed) &&
              !/^[{}\[\]\\\/]{5,}$/.test(trimmed) &&
              !/^[\x00-\x1f\x7f]+$/.test(trimmed)) {
            textRuns.push(trimmed);
            totalChars += trimmed.length;
          }
        }
        currentRun = "";
      }
    }

    if (currentRun.trim().length >= MIN_WORD_LENGTH && totalChars < MAX_OUTPUT_CHARS) {
      textRuns.push(currentRun.trim());
    }

    const cleaned = textRuns.join(" ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{3,}/g, " ")
      .trim();

    if (cleaned.length < 50) return "[Could not extract meaningful text from legacy .doc file]";
    if (cleaned.length > MAX_OUTPUT_CHARS) return cleaned.substring(0, MAX_OUTPUT_CHARS) + "\n[Text truncated...]";
    return cleaned;
  } catch (err) {
    return `[DOC text extraction failed: ${(err as Error).message}]`;
  }
}

function extractTextFromRtf(base64Data: string): string {
  try {
    const text = atob(base64Data);
    const cleaned = text
      .replace(/\{\\[^{}]*\}/g, "")
      .replace(/\\[a-z]+[-]?\d*\s?/g, " ")
      .replace(/[{}]/g, "")
      .replace(/\\\\/g, "\\")
      .replace(/\\'[0-9a-f]{2}/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{3,}/g, " ")
      .trim();

    if (cleaned.length < 50) return "[Could not extract meaningful text from RTF file]";
    return cleaned;
  } catch (err) {
    return `[RTF text extraction failed: ${(err as Error).message}]`;
  }
}

// ============================================================================
// Claude AI Helper — dynamic system prompt per vertical
// ============================================================================

async function extractCandidateWithClaude(
  attachmentBase64: string,
  mimeType: string,
  filename: string,
  anthropicApiKey: string,
  systemPrompt: string,
): Promise<ClaudeResponse> {
  const standardBase64 = attachmentBase64.replace(/-/g, "+").replace(/_/g, "/");
  const content: Array<Record<string, unknown>> = [];

  if (mimeType === "application/pdf") {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: standardBase64 },
    });
    content.push({
      type: "text",
      text: `Parse this document (filename: "${filename}"). Return ONLY the JSON object as specified. If this is not a CV/resume, return {"candidates": []}.`,
    });
  } else {
    let extractedText: string;
    const ext = filename.split(".").pop()?.toLowerCase() || "";

    if (ext === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      console.log(`[Claude] Extracting text from DOCX: ${filename}`);
      extractedText = await extractTextFromDocx(standardBase64);
    } else if (ext === "doc" || mimeType === "application/msword") {
      console.log(`[Claude] Extracting text from DOC: ${filename}`);
      extractedText = extractTextFromDoc(standardBase64);
    } else if (ext === "rtf" || mimeType === "application/rtf" || mimeType === "text/rtf") {
      console.log(`[Claude] Extracting text from RTF: ${filename}`);
      extractedText = extractTextFromRtf(standardBase64);
    } else {
      extractedText = `[Unsupported file type: ${mimeType} / .${ext}]`;
    }

    content.push({
      type: "text",
      text: `Parse the following document text extracted from "${filename}". Return ONLY the JSON object as specified. If this is not a CV/resume, return {"candidates": []}.\n\n--- DOCUMENT TEXT ---\n${extractedText}\n--- END DOCUMENT TEXT ---`,
    });
  }

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
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${text}`);
  }

  const result = await response.json();
  const textContent = result.content?.find((c: { type: string }) => c.type === "text");
  if (!textContent?.text) throw new Error("Claude returned no text content");

  let jsonStr = textContent.text.trim();
  if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
  if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
  if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
  jsonStr = jsonStr.trim();

  if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
  }

  let parsed: ClaudeResponse;
  try {
    parsed = JSON.parse(jsonStr) as ClaudeResponse;
  } catch (parseErr) {
    console.error(`JSON parse failed: ${(parseErr as Error).message}`);
    console.error(`Raw response (first 500 chars): ${jsonStr.substring(0, 500)}`);
    return { candidates: [] };
  }

  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
    return { candidates: [] };
  }

  return parsed;
}

// ============================================================================
// Universal Qualification Gate
// ============================================================================

function evaluateRule(candidate: CandidateExtraction, rule: GateRule): boolean {
  const value = candidate[rule.field];
  switch (rule.op) {
    case "eq": return value === rule.value;
    case "ne": return value !== rule.value;
    case "lt": return typeof value === "number" && value < (rule.value as number);
    case "gt": return typeof value === "number" && value > (rule.value as number);
    default: return false;
  }
}

function applyQualificationGate(
  candidate: CandidateExtraction,
  gateRules: GateRules,
): GateResult {
  // Universal hard gate: AI sets has_required_qualification per vertical's criteria
  if (!candidate.has_required_qualification) {
    return {
      pass: false,
      action: "reject",
      reason: "Does not meet vertical qualification requirement",
      flags: [],
    };
  }

  // Additional hard rules from gate_rules jsonb
  for (const rule of gateRules.hard || []) {
    if (evaluateRule(candidate, rule)) {
      return { pass: false, action: "reject", reason: rule.reason, flags: [] };
    }
  }

  // Soft rules — flag but don't reject
  const flags: string[] = [];
  for (const rule of gateRules.soft || []) {
    if (evaluateRule(candidate, rule)) flags.push(rule.reason);
  }

  return {
    pass: true,
    action: flags.length > 0 ? "flag" : "pass",
    reason: flags.length > 0 ? `Passed with flags: ${flags.join("; ")}` : "Passed all qualification gates",
    flags,
  };
}

// ============================================================================
// Teaching backward-compat column mapping
// Populates Nicole's existing dashboard columns from raw_extraction fields.
// Called only when vertical_name === 'teaching' or no vertical is set.
// ============================================================================

function mapTeachingFields(candidate: CandidateExtraction): Record<string, unknown> {
  const degreeInstitutionRaw = candidate.degree_institution_raw as string | null || null;
  const degreeNorm = degreeInstitutionRaw
    ? degreeInstitutionRaw.toLowerCase().replace(/[^a-zA-Z0-9]+/g, " ").trim()
    : null;

  return {
    educational_qualifications_raw: candidate.educational_qualifications_raw as string || null,
    degree_institution_raw: degreeInstitutionRaw,
    degree_country_raw: candidate.degree_country_raw as string || null,
    degree_institution_norm: degreeNorm,
    has_education_degree: candidate.has_education_degree as boolean || false,
    qualification_type: candidate.qualification_type as string || "Unknown",
    years_teaching_experience: (candidate.years_teaching_experience as number) ?? candidate.years_experience ?? 0,
    teaching_phase_specialisation: candidate.teaching_phase_specialisation as string || "Unknown",
    teaching_phase_alignment: candidate.teaching_phase_alignment as string || "unknown",
    has_tefl: candidate.has_tefl as boolean || false,
    has_tesol: candidate.has_tesol as boolean || false,
    has_celta: candidate.has_celta as boolean || false,
  };
}

// ============================================================================
// Hallucination Check
// ============================================================================

function isHallucinatedCandidate(name: string): boolean {
  if (!name) return true;
  const normalized = name.toLowerCase().trim();
  if (HALLUCINATED_NAMES.has(normalized)) return true;
  if (normalized.length < 3) return true;
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
  if (size < MIN_ATTACHMENT_SIZE) return { allowed: false, reason: `File too small: ${size} bytes` };
  if (size > MAX_ATTACHMENT_SIZE) return { allowed: false, reason: `File too large: ${size} bytes` };

  const ext = getFileExtension(filename);
  if (ext && BLOCKED_EXTENSIONS.has(ext)) return { allowed: false, reason: `Blocked extension: .${ext}` };
  if (ALLOWED_MIME_TYPES.has(mimeType)) return { allowed: true, reason: "Allowed by MIME type" };
  if (ext && ALLOWED_EXTENSIONS.has(ext)) return { allowed: true, reason: `Allowed by extension: .${ext}` };
  return { allowed: false, reason: `Unknown type: ${mimeType} / .${ext}` };
}

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
    if (part.parts) attachments.push(...extractAttachmentParts(part.parts));
  }
  return attachments;
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// ============================================================================
// Audit Logger
// ============================================================================

async function auditLog(supabase: SupabaseClient, entry: AuditEntry): Promise<void> {
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
    console.error("Audit log insert failed:", err);
  }
}

// ============================================================================
// Date Helpers
// ============================================================================

function getTargetDayRange(targetDay: string, tzId: string): { after: number; before: number } {
  const tzOffsets: Record<string, number> = { "Africa/Johannesburg": 2, "UTC": 0 };
  const offsetHours = tzOffsets[tzId] ?? 2;
  const dayStart = new Date(`${targetDay}T00:00:00Z`);
  dayStart.setUTCHours(dayStart.getUTCHours() - offsetHours);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return {
    after: Math.floor(dayStart.getTime() / 1000),
    before: Math.floor(dayEnd.getTime() / 1000),
  };
}

function deriveCanonicalDay(emailDate: string | Date): string {
  const date = typeof emailDate === "string" ? new Date(emailDate) : emailDate;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// ============================================================================
// Route Flattening — resolves nested join into flat Route object
// ============================================================================

// deno-lint-ignore no-explicit-any
function flattenRoute(raw: any): Route {
  const org = raw.organizations || {};
  const vt = org.vertical_templates || null;

  // Resolve system prompt: base template + client additions (appended, never replaced)
  const basePrompt: string = vt?.ai_system_prompt || TEACHING_FALLBACK_PROMPT;
  const ai_system_prompt: string = org.ai_prompt_override
    ? `${basePrompt}\n\n---\nCLIENT-SPECIFIC SCREENING CRITERIA (apply these in addition to the above):\n${org.ai_prompt_override}`
    : basePrompt;

  // Resolve gate rules: org override > vertical template > empty
  const gate_rules: GateRules =
    (org.gate_rules_override as GateRules) ||
    (vt?.gate_rules as GateRules) ||
    {};

  return {
    id: raw.id,
    source_email: raw.source_email,
    user_id: raw.user_id,
    organization_id: raw.organization_id,
    inbox_tz_id: raw.inbox_tz_id,
    gmail_token_id: raw.gmail_token_id || undefined,
    vertical_name: vt?.name || undefined,
    ai_system_prompt,
    gate_rules,
  };
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
      await processMessage(msgRef.id, route, runId, gmail, supabase, anthropicApiKey, stats);
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
  // Idempotency check
  const { data: existingEmail } = await supabase
    .from("email_queue")
    .select("id, status")
    .eq("gmail_message_id", messageId)
    .eq("organization_id", route.organization_id)
    .limit(1);

  if (existingEmail && existingEmail.length > 0) {
    console.log(`[Message ${messageId}] Already in email_queue, skipping`);
    return;
  }

  const message = await gmail.getMessage(messageId);
  const headers = message.payload.headers;
  const senderEmail = getHeader(headers, "From");
  const subject = getHeader(headers, "Subject");
  const emailDateStr = getHeader(headers, "Date");
  const emailDate = emailDateStr ? new Date(emailDateStr) : new Date(parseInt(message.internalDate));
  const attachments = extractAttachmentParts(message.payload.parts);

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
      subject,
      email_date: emailDate.toISOString(),
      attachment_count: attachments.length,
      status: "processing",
    })
    .select()
    .single();

  if (eqError) {
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
    context: { gmail_message_id: messageId, subject, sender: senderEmail, email_date: emailDate.toISOString(), attachment_count: attachments.length },
  });

  if (attachments.length === 0) {
    await supabase.from("email_queue").update({ status: "skipped", processed_at: new Date().toISOString() }).eq("id", emailQueueId);
    return;
  }

  let anyProcessed = false;

  for (const attachment of attachments) {
    stats.attachments_total++;

    const filterResult = isAllowedAttachment(attachment.filename, attachment.mimeType, attachment.size);
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
        context: { filename: attachment.filename, mime_type: attachment.mimeType, size: attachment.size },
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
      context: { filename: attachment.filename, mime_type: attachment.mimeType, size: attachment.size },
    });

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

    // Use vertical-specific system prompt (or teaching fallback)
    const systemPrompt = route.ai_system_prompt || TEACHING_FALLBACK_PROMPT;

    let claudeResult: ClaudeResponse;
    try {
      stats.ai_calls_made++;
      claudeResult = await extractCandidateWithClaude(
        attachmentData,
        attachment.mimeType,
        attachment.filename,
        anthropicApiKey,
        systemPrompt,
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
        context: { filename: attachment.filename, vertical: route.vertical_name },
      });
      continue;
    }

    if (claudeResult.candidates.length === 0) {
      await auditLog(supabase, {
        run_id: runId,
        email_queue_id: emailQueueId,
        organization_id: route.organization_id,
        user_id: route.user_id,
        stage: "ai_not_cv",
        action: "skip",
        reason: "Claude determined this is not a CV",
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
      reason: `Extracted ${claudeResult.candidates.length} candidate(s) [vertical: ${route.vertical_name || "teaching"}]`,
      context: { filename: attachment.filename, candidate_names: claudeResult.candidates.map((c) => c.candidate_name) },
    });

    for (const candidate of claudeResult.candidates) {
      stats.candidates_extracted++;

      // Hallucination check
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

      // Universal qualification gate
      const gateResult = applyQualificationGate(candidate, route.gate_rules);

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
            has_required_qualification: candidate.has_required_qualification,
            years_experience: candidate.years_experience,
            vertical: route.vertical_name,
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

      // Deduplication check (24h window)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let dupeQuery = supabase
        .from("candidates")
        .select("id, candidate_name, email_address, created_at")
        .eq("organization_id", route.organization_id)
        .gte("created_at", twentyFourHoursAgo);

      if (candidate.email_address && candidate.email_address.trim()) {
        dupeQuery = dupeQuery.ilike("email_address", candidate.email_address.trim());
      } else {
        dupeQuery = dupeQuery.ilike("candidate_name", candidate.candidate_name.trim());
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
          context: { existing_id: existingDupes[0].id, match_by: candidate.email_address ? "email" : "name" },
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

      const canonicalDay = deriveCanonicalDay(emailDate);
      const verticalName = route.vertical_name || "teaching";
      const isTeaching = verticalName === "teaching";

      // Build candidate row — universal fields first, then vertical-specific
      const candidateRow: Record<string, unknown> = {
        // Universal / common fields
        user_id: route.user_id,
        organization_id: route.organization_id,
        source_email: route.source_email,
        canonical_day: canonicalDay,
        date_received: emailDate.toISOString(),
        candidate_name: candidate.candidate_name,
        email_address: candidate.email_address || null,
        contact_number: candidate.contact_number || null,
        current_location_raw: candidate.current_location_raw || null,
        countries_raw: candidate.countries_raw || [],
        raw_ai_score: candidate.raw_ai_score || 0,
        ai_notes: candidate.ai_notes || null,
        // Multi-tenant fields
        raw_extraction: candidate,
        vertical: verticalName,
        // Teaching-specific columns — populated for teaching (Nicole's dashboard),
        // null/defaults for all other verticals
        ...(isTeaching
          ? mapTeachingFields(candidate)
          : {
              educational_qualifications_raw: null,
              degree_institution_raw: null,
              degree_country_raw: null,
              degree_institution_norm: null,
              has_education_degree: false,
              qualification_type: "Unknown",
              years_teaching_experience: 0,
              teaching_phase_specialisation: "Unknown",
              teaching_phase_alignment: "unknown",
              has_tefl: false,
              has_tesol: false,
              has_celta: false,
            }),
      };

      const { data: inserted, error: insertError } = await supabase
        .from("candidates")
        .insert(candidateRow)
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
      console.log(`✓ Inserted: ${candidate.candidate_name} (${inserted.id}) [${verticalName}]`);

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
          vertical: verticalName,
          has_required_qualification: candidate.has_required_qualification,
          years_experience: candidate.years_experience,
          raw_ai_score: candidate.raw_ai_score,
        },
      });
    }
  }

  await supabase
    .from("email_queue")
    .update({ status: anyProcessed ? "completed" : "skipped", processed_at: new Date().toISOString() })
    .eq("id", emailQueueId);
}

// ============================================================================
// Entry Point
// ============================================================================

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    let targetDay: string;
    try {
      const body = await req.json();
      targetDay = body.target_day;
    } catch {
      targetDay = "";
    }

    if (!targetDay) {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      targetDay = deriveCanonicalDay(yesterday);
    }

    console.log(`=== Processing candidates for ${targetDay} ===`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Create processing run
    const { data: run, error: runError } = await supabase
      .from("processing_runs")
      .insert({ target_day: targetDay, status: "running", triggered_by: "manual" })
      .select()
      .single();

    if (runError) throw new Error(`Failed to create processing run: ${runError.message}`);

    const runId = run.id;
    const stats: ProcessingRun = {
      id: runId,
      routes_processed: 0, emails_fetched: 0,
      attachments_total: 0, attachments_processed: 0, attachments_skipped: 0,
      candidates_extracted: 0, candidates_inserted: 0,
      candidates_rejected: 0, candidates_duplicates: 0,
      ai_calls_made: 0, errors_count: 0,
    };

    // Fetch all routes with vertical config via join
    const { data: rawRoutes, error: routesError } = await supabase
      .from("inbound_email_routes")
      .select(`
        id, source_email, user_id, organization_id, inbox_tz_id, gmail_token_id,
        organizations (
          ai_prompt_override, gate_rules_override,
          vertical_templates (
            name, ai_system_prompt, ai_extraction_schema, gate_rules
          )
        )
      `);

    if (routesError) throw new Error(`Failed to fetch routes: ${routesError.message}`);

    const routes: Route[] = (rawRoutes || []).map(flattenRoute);
    console.log(`Found ${routes.length} routes to process`);

    // Process each route with its own Gmail client
    for (const route of routes) {
      stats.routes_processed++;
      console.log(`\n--- Processing route: ${route.source_email} [vertical: ${route.vertical_name || "teaching"}] ---`);

      try {
        // Resolve Gmail access token (per-org or shared env fallback)
        const accessToken = await resolveGmailAccessToken(route, supabase);
        const gmail = new GmailClient(accessToken);

        await processRoute(route, targetDay, runId, gmail, supabase, anthropicApiKey, stats);
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

    // Finalize run
    const durationMs = Date.now() - startTime;
    const finalStatus = stats.errors_count > 0 ? "completed_with_errors" : "completed";

    await supabase.from("processing_runs").update({
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
    }).eq("id", runId);

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
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error("Fatal pipeline error:", error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message, duration_ms: durationMs }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
