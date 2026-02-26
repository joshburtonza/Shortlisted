// ============================================================================
// org-config/index.ts
// Client-facing configuration API — per-org screening criteria.
//
// GET  /org-config              → user JWT → returns caller's org config
// GET  /org-config?org_id=xxx  → service role → returns any org (admin use)
// PATCH /org-config             → user JWT → updates caller's org overrides
//
// PATCH body:
//   { prompt_additions?: string | null, min_years_experience?: number | null }
//
// Isolation: each user can only read/write their own org (matched via owner_id).
// Service role (Josh) can query any org via ?org_id=.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ============================================================================
// Auth helpers
// ============================================================================

function isJwt(token: string): boolean {
  // JWTs have exactly 2 dots (header.payload.signature)
  // Supabase service role keys and newer sb_secret_ keys are not JWTs
  return token.split(".").length === 3;
}

async function getUserId(
  supabaseUrl: string,
  anonKey: string,
  authHeader: string,
): Promise<string | null> {
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await client.auth.getUser();
  return user?.id || null;
}

// ============================================================================
// Org resolution
// ============================================================================

// deno-lint-ignore no-explicit-any
async function fetchOrg(supabaseAdmin: any, filter: { id?: string; owner_id?: string }) {
  const query = supabaseAdmin
    .from("organizations")
    .select(`
      id, name, slug, vertical, owner_id, contact_name, contact_email,
      onboarding_status, ai_prompt_override, gate_rules_override,
      vertical_templates (
        id, name, display_name, ai_system_prompt, gate_rules
      )
    `);

  if (filter.id)       query.eq("id", filter.id);
  if (filter.owner_id) query.eq("owner_id", filter.owner_id);

  const { data, error } = await query.single();
  return { data, error };
}

// ============================================================================
// Response shaping
// ============================================================================

// deno-lint-ignore no-explicit-any
function shapeResponse(org: any) {
  // deno-lint-ignore no-explicit-any
  const vt = org.vertical_templates as any || null;
  const gateOverride = org.gate_rules_override as {
    soft?: Array<{ field: string; op: string; value: unknown }>;
    hard?: Array<unknown>;
  } | null;

  let minYearsExperience: number | null = null;
  if (gateOverride?.soft) {
    const rule = gateOverride.soft.find(
      (r) => r.field === "years_experience" && r.op === "lt",
    );
    if (rule) minYearsExperience = rule.value as number;
  }

  return {
    org: {
      id:                 org.id,
      name:               org.name,
      slug:               org.slug,
      vertical:           org.vertical,
      contact_name:       org.contact_name,
      contact_email:      org.contact_email,
      onboarding_status:  org.onboarding_status,
    },
    vertical_template: vt ? {
      id:               vt.id,
      name:             vt.name,
      display_name:     vt.display_name,
      ai_system_prompt: vt.ai_system_prompt,
      gate_rules:       vt.gate_rules,
    } : null,
    overrides: {
      prompt_additions:     org.ai_prompt_override || null,
      min_years_experience: minYearsExperience,
    },
  };
}

// ============================================================================
// Entry point
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey        = Deno.env.get("SUPABASE_ANON_KEY")!;

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const serviceRoleCaller = token && !isJwt(token);
  const url = new URL(req.url);
  const orgIdParam = url.searchParams.get("org_id");

  // ---- GET ----
  if (req.method === "GET") {
    if (!token) return err("Unauthorised", 401);

    let orgData;

    if (serviceRoleCaller && orgIdParam) {
      // Admin: fetch any org by ID
      const { data, error } = await fetchOrg(supabaseAdmin, { id: orgIdParam });
      if (error || !data) return err("Organisation not found", 404);
      orgData = data;
    } else if (isJwt(token)) {
      // Client: resolve from their user ID
      const userId = await getUserId(supabaseUrl, anonKey, authHeader);
      if (!userId) return err("Invalid or expired token", 401);
      const { data, error } = await fetchOrg(supabaseAdmin, { owner_id: userId });
      if (error || !data) return err("No organisation found for this account", 404);
      orgData = data;
    } else {
      return err("Unauthorised", 401);
    }

    return json(shapeResponse(orgData));
  }

  // ---- PATCH ----
  if (req.method === "PATCH") {
    if (!isJwt(token)) return err("Unauthorised — PATCH requires a user login", 401);

    const userId = await getUserId(supabaseUrl, anonKey, authHeader);
    if (!userId) return err("Invalid or expired token", 401);

    const { data: orgData, error: resolveError } = await fetchOrg(
      supabaseAdmin, { owner_id: userId },
    );
    if (resolveError || !orgData) return err("No organisation found for this account", 404);

    let body: { prompt_additions?: string | null; min_years_experience?: number | null };
    try {
      body = await req.json();
    } catch {
      return err("Invalid JSON body");
    }

    const updates: Record<string, unknown> = {};

    // ---- Prompt additions ----
    if ("prompt_additions" in body) {
      const val = body.prompt_additions;
      updates.ai_prompt_override =
        typeof val === "string" && val.trim() ? val.trim() : null;
    }

    // ---- Min years experience → gate_rules_override ----
    if ("min_years_experience" in body) {
      const minYears = body.min_years_experience;

      if (minYears !== null && minYears !== undefined) {
        if (typeof minYears !== "number" || minYears < 0 || minYears > 50) {
          return err("min_years_experience must be a number between 0 and 50");
        }
      }

      const existing = (orgData.gate_rules_override as {
        hard?: unknown[];
        soft?: Array<{ field: string }>;
      }) || {};

      const hardRules = existing.hard || [];
      const otherSoft = (existing.soft || []).filter(
        (r) => r.field !== "years_experience",
      );

      const newSoft =
        minYears && minYears > 0
          ? [
              ...otherSoft,
              {
                field:  "years_experience",
                op:     "lt",
                value:  minYears,
                reason: `Less than ${minYears} year${minYears === 1 ? "" : "s"} experience`,
              },
            ]
          : otherSoft;

      updates.gate_rules_override = { hard: hardRules, soft: newSoft };
    }

    if (Object.keys(updates).length === 0) {
      return err("No recognised fields in request body");
    }

    const { error: updateError } = await supabaseAdmin
      .from("organizations")
      .update(updates)
      .eq("id", orgData.id);

    if (updateError) return err(`Update failed: ${updateError.message}`, 500);

    // Return fresh config
    const { data: refreshed } = await fetchOrg(supabaseAdmin, { owner_id: userId });
    return json(shapeResponse(refreshed!));
  }

  return err("Method not allowed", 405);
});
