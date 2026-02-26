// ============================================================================
// OrgConfigPage.tsx
// Drop this file into your Lovable project.
// Add it as a route, e.g. /config in your app router.
//
// Requires: @supabase/supabase-js (already in Lovable projects)
// ============================================================================

import { useState, useEffect, useCallback } from "react";
import { createClient, Session } from "@supabase/supabase-js";

// ---- Update these two values ----
const SUPABASE_URL  = "https://fjkskuknvofmsrocoaws.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqa3NrdWtudm9mbXNyb2NvYXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3ODUwNDcsImV4cCI6MjA3MTM2MTA0N30.JKsQ1BdyXGdxoVHyYyJrKzo3nvJCHyy0MUvyFo3lHIc";

const CONFIG_URL = `${SUPABASE_URL}/functions/v1/org-config`;
const supabase   = createClient(SUPABASE_URL, SUPABASE_ANON);

// ============================================================================
// Types
// ============================================================================
interface GateRule {
  field: string;
  op:    string;
  value: unknown;
  reason: string;
}

interface OrgConfig {
  org: {
    id:                string;
    name:              string;
    vertical:          string;
    contact_name:      string | null;
    contact_email:     string | null;
    onboarding_status: string;
  };
  vertical_template: {
    name:             string;
    display_name:     string;
    ai_system_prompt: string;
    gate_rules: {
      hard?: GateRule[];
      soft?: GateRule[];
    };
  } | null;
  overrides: {
    prompt_additions:     string | null;
    min_years_experience: number | null;
  };
}

// ============================================================================
// Component
// ============================================================================
export default function OrgConfigPage() {
  const [session,          setSession]          = useState<Session | null>(null);
  const [config,           setConfig]           = useState<OrgConfig | null>(null);
  const [promptAdditions,  setPromptAdditions]  = useState("");
  const [minYears,         setMinYears]         = useState("");
  const [loading,          setLoading]          = useState(true);
  const [saving,           setSaving]           = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [saved,            setSaved]            = useState(false);
  const [showBaseTemplate, setShowBaseTemplate] = useState(false);

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Fetch config
  const fetchConfig = useCallback(async (token: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(CONFIG_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error);
      }
      const data: OrgConfig = await res.json();
      setConfig(data);
      setPromptAdditions(data.overrides.prompt_additions || "");
      setMinYears(
        data.overrides.min_years_experience != null
          ? String(data.overrides.min_years_experience)
          : "",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session?.access_token) fetchConfig(session.access_token);
    else if (session === null)  setLoading(false);
  }, [session, fetchConfig]);

  // Save
  const handleSave = async () => {
    if (!session?.access_token) return;
    setSaving(true);
    setSaved(false);
    setError(null);

    const body: { prompt_additions?: string | null; min_years_experience?: number | null } = {
      prompt_additions: promptAdditions.trim() || null,
    };

    if (minYears.trim() === "") {
      body.min_years_experience = null;
    } else {
      const n = parseInt(minYears, 10);
      if (isNaN(n) || n < 0 || n > 50) {
        setError("Minimum years must be a number between 0 and 50.");
        setSaving(false);
        return;
      }
      body.min_years_experience = n;
    }

    try {
      const res = await fetch(CONFIG_URL, {
        method:  "PATCH",
        headers: {
          Authorization:  `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(b.error);
      }
      const updated: OrgConfig = await res.json();
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Default min years from vertical template
  const defaultMinYears = (): number => {
    const soft = config?.vertical_template?.gate_rules?.soft || [];
    const rule = soft.find((r) => r.field === "years_experience" && r.op === "lt");
    return rule ? (rule.value as number) : 2;
  };

  // ---- Render ----
  if (!session) return (
    <div style={s.page}>
      <p style={s.muted}>Please sign in to access your settings.</p>
    </div>
  );

  if (loading) return (
    <div style={s.page}>
      <p style={s.muted}>Loading your configuration...</p>
    </div>
  );

  if (error && !config) return (
    <div style={s.page}>
      <p style={{ ...s.muted, color: "#ef4444" }}>Error: {error}</p>
    </div>
  );

  if (!config) return null;

  const verticalLabel = config.vertical_template?.display_name || config.org.vertical;

  return (
    <div style={s.page}>
      <div style={s.card}>

        {/* Header */}
        <div style={s.header}>
          <h1 style={s.title}>Screening Settings</h1>
          <div style={s.orgRow}>
            <span style={s.orgName}>{config.org.name}</span>
            <span style={s.badge}>{verticalLabel}</span>
          </div>
          <p style={s.subtitle}>
            Customise how Shortlisted screens CVs for your organisation.
            Changes apply from the next nightly run onwards.
          </p>
        </div>

        {/* What are you looking for */}
        <div style={s.field}>
          <label style={s.label} htmlFor="additions">
            What are you specifically looking for?
          </label>
          <p style={s.hint}>
            Add requirements on top of the standard {verticalLabel} screening.
            Leave blank to use the defaults.
          </p>
          <textarea
            id="additions"
            style={s.textarea}
            rows={6}
            value={promptAdditions}
            onChange={(e) => setPromptAdditions(e.target.value)}
            placeholder={[
              "Examples:",
              "- Only Foundation Phase teachers (Grades R–3)",
              "- Must have Maths or Science as a teaching subject",
              "- Prefer candidates currently based in the Western Cape",
              "- Minimum 3 years in a private school environment",
            ].join("\n")}
          />
        </div>

        {/* Min years */}
        <div style={s.field}>
          <label style={s.label} htmlFor="minyears">
            Minimum years of experience
          </label>
          <p style={s.hint}>
            Candidates below this threshold will be flagged in your dashboard.
            Leave blank to use the default ({defaultMinYears()} years for {verticalLabel}).
          </p>
          <input
            id="minyears"
            type="number"
            min={0}
            max={50}
            style={s.numInput}
            value={minYears}
            onChange={(e) => setMinYears(e.target.value)}
            placeholder={String(defaultMinYears())}
          />
        </div>

        {/* View base template */}
        {config.vertical_template && (
          <div style={s.field}>
            <button
              style={s.toggleBtn}
              type="button"
              onClick={() => setShowBaseTemplate((v) => !v)}
            >
              {showBaseTemplate ? "Hide" : "View"} base {verticalLabel} screening template
            </button>
            {showBaseTemplate && (
              <pre style={s.preBlock}>{config.vertical_template.ai_system_prompt}</pre>
            )}
          </div>
        )}

        {/* Feedback */}
        {error  && <p style={{ ...s.feedback, color: "#ef4444" }}>Error: {error}</p>}
        {saved  && <p style={{ ...s.feedback, color: "#16a34a" }}>Settings saved.</p>}

        {/* Save */}
        <button
          style={{ ...s.saveBtn, opacity: saving ? 0.6 : 1 }}
          type="button"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>

      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================
const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight:       "100vh",
    backgroundColor: "#f8fafc",
    display:         "flex",
    justifyContent:  "center",
    padding:         "2rem 1rem",
    fontFamily:      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius:    "12px",
    boxShadow:       "0 1px 3px rgba(0,0,0,.1)",
    padding:         "2rem",
    width:           "100%",
    maxWidth:        "700px",
    alignSelf:       "flex-start",
  },
  header: {
    marginBottom:  "2rem",
    paddingBottom: "1.5rem",
    borderBottom:  "1px solid #e2e8f0",
  },
  title:   { fontSize: "1.5rem", fontWeight: 700, color: "#1e293b", margin: "0 0 .5rem" },
  orgRow:  { display: "flex", alignItems: "center", gap: ".75rem", marginBottom: ".75rem" },
  orgName: { fontSize: "1rem", fontWeight: 600, color: "#334155" },
  badge:   {
    backgroundColor: "#eff6ff",
    color:           "#2563eb",
    fontSize:        ".75rem",
    fontWeight:      600,
    padding:         ".2rem .6rem",
    borderRadius:    "9999px",
    border:          "1px solid #bfdbfe",
  },
  subtitle: { fontSize: ".875rem", color: "#64748b", margin: 0, lineHeight: 1.6 },
  field:    { marginBottom: "1.75rem" },
  label:    { display: "block", fontSize: ".9rem", fontWeight: 600, color: "#1e293b", marginBottom: ".4rem" },
  hint:     { fontSize: ".8rem", color: "#64748b", marginBottom: ".6rem", lineHeight: 1.5 },
  textarea: {
    width:       "100%",
    border:      "1px solid #cbd5e1",
    borderRadius: "8px",
    padding:     ".75rem",
    fontSize:    ".875rem",
    lineHeight:  1.6,
    resize:      "vertical",
    fontFamily:  "inherit",
    color:       "#334155",
    boxSizing:   "border-box",
    outline:     "none",
  },
  numInput: {
    border:       "1px solid #cbd5e1",
    borderRadius: "8px",
    padding:      ".6rem .75rem",
    fontSize:     ".9rem",
    width:        "120px",
    color:        "#334155",
    outline:      "none",
  },
  toggleBtn: {
    background:   "none",
    border:       "1px solid #cbd5e1",
    borderRadius: "6px",
    padding:      ".4rem .75rem",
    fontSize:     ".8rem",
    color:        "#475569",
    cursor:       "pointer",
    marginBottom: ".75rem",
  },
  preBlock: {
    backgroundColor: "#f8fafc",
    border:          "1px solid #e2e8f0",
    borderRadius:    "8px",
    padding:         "1rem",
    fontSize:        ".72rem",
    color:           "#475569",
    whiteSpace:      "pre-wrap",
    maxHeight:       "400px",
    overflowY:       "auto",
    lineHeight:      1.6,
  },
  feedback: { fontSize: ".875rem", fontWeight: 500, marginBottom: "1rem" },
  saveBtn:  {
    backgroundColor: "#2563eb",
    color:           "#fff",
    border:          "none",
    borderRadius:    "8px",
    padding:         ".75rem 2rem",
    fontSize:        ".95rem",
    fontWeight:      600,
    width:           "100%",
    cursor:          "pointer",
  },
  muted: { color: "#64748b", fontSize: "1rem" },
};
