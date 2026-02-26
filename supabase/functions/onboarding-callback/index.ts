// ============================================================================
// onboarding-callback/index.ts
// Self-service client onboarding — zero infrastructure, no extra deployments.
//
// Three modes (same URL):
//
//   GET ?vertical=teaching   → immediately redirects to Google OAuth consent
//   GET ?code=...&state=...  → handles Google OAuth callback, creates org
//   GET (no params)          → plain-text index showing per-vertical links
//
// Client experience (1 click):
//   Josh sends client: https://<fn-url>?vertical=legal
//   Client clicks → Google consent → done
//
// Everything is derived automatically:
//   - Gmail address      → from Google OAuth userinfo
//   - Contact name       → from Google profile
//   - Company name       → from email domain (formatted)
//
// Redirect URI to register in Google Cloud Console:
//   https://fjkskuknvofmsrocoaws.supabase.co/functions/v1/onboarding-callback
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";

// ============================================================================
// Config
// ============================================================================

const VERTICALS: Record<string, string> = {
  teaching: "Education / Teaching",
  legal:    "Legal",
  tech:     "Technology / Engineering",
  medical:  "Medical & Healthcare",
  finance:  "Finance & Accounting",
  generic:  "General / Other",
};

const FUNCTION_URL = "https://fjkskuknvofmsrocoaws.supabase.co/functions/v1/onboarding-callback";

// ============================================================================
// Helpers
// ============================================================================

function slugify(str: string): string {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// "acme-recruitment.co.za" -> "Acme Recruitment"
function companyNameFromDomain(email: string): string {
  const domain = email.split("@")[1] || "";
  const base = domain.split(".")[0] || "";
  return base
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function txt(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

// ============================================================================
// Mode 1: Redirect to Google OAuth
// ============================================================================

function startOAuth(vertical: string): Response {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID") || "";

  // Encode vertical as base64url state param — echoed back by Google
  const state = btoa(JSON.stringify({ vertical }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  FUNCTION_URL,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ].join(" "),
    access_type: "offline",
    prompt:      "consent",
    state,
  });

  return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
}

// ============================================================================
// Mode 2: OAuth Callback Handler
// ============================================================================

async function handleCallback(url: URL): Promise<Response> {
  const code       = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return txt(`Google sign-in failed: ${oauthError}\n\nPlease try again.`, 400);
  }

  if (!code) {
    return txt("No authorisation code received from Google. Please try again.", 400);
  }

  // Decode state -> { vertical }
  let vertical = "generic";
  if (stateParam) {
    try {
      const decoded = JSON.parse(atob(stateParam.replace(/-/g, "+").replace(/_/g, "/")));
      vertical = decoded.vertical || "generic";
    } catch {
      // Use default
    }
  }

  const clientId     = Deno.env.get("GMAIL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET")!;

  try {
    // ---- Exchange code for tokens ----
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  FUNCTION_URL,
        grant_type:    "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Token exchange failed: ${tokenResp.status} — ${text}`);
    }

    const tokenData      = await tokenResp.json();
    const accessToken:  string   = tokenData.access_token;
    const refreshToken: string   = tokenData.refresh_token;
    const expiresIn:    number   = tokenData.expires_in || 3600;
    const scopes:       string[] = (tokenData.scope || "").split(" ");

    if (!refreshToken) {
      throw new Error(
        "Google did not return a refresh token. " +
        "Please go to myaccount.google.com/permissions, revoke Shortlisted access, and try again.",
      );
    }

    // ---- Get profile from Google ----
    const profileResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileResp.ok) throw new Error("Could not fetch Google profile");

    const profile      = await profileResp.json();
    const gmailEmail:  string = profile.email;
    const contactName: string = profile.name || "";
    const companyName: string = companyNameFromDomain(gmailEmail) || contactName;
    const slug:        string = slugify(companyName) || slugify(gmailEmail.split("@")[0]);
    const tokenExpiresAt     = new Date(Date.now() + expiresIn * 1000).toISOString();

    // ---- Write to Supabase ----
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ---- Check for existing org (re-auth / upgrade path) ----
    // If this Gmail address already has an inbound_email_route, update rather than create.
    const { data: existingRoutes } = await supabase
      .from("inbound_email_routes")
      .select("id, organization_id")
      .eq("source_email", gmailEmail);

    if (existingRoutes && existingRoutes.length > 0) {
      const existingOrgId = existingRoutes[0].organization_id;
      // Fetch org name separately (no join — avoids silent FK failures)
      const { data: existingOrg } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", existingOrgId)
        .single();
      const existingOrgName = existingOrg?.name || companyName;
      // Fetch ALL routes for this org (not just the matched email — covers multi-inbox orgs)
      const { data: allOrgRoutes } = await supabase
        .from("inbound_email_routes")
        .select("id")
        .eq("organization_id", existingOrgId);
      const allRouteIds = (allOrgRoutes || existingRoutes).map((r: { id: string }) => r.id);
      return await finalizeExisting(
        supabase, existingOrgId, allRouteIds,
        gmailEmail, refreshToken, accessToken, tokenExpiresAt, scopes,
        vertical, existingOrgName,
      );
    }

    // ---- New org path ----
    // Resolve vertical_id
    const { data: verticalRow } = await supabase
      .from("vertical_templates")
      .select("id")
      .eq("name", vertical)
      .single();

    const verticalId = verticalRow?.id || null;

    const insertOrg = {
      name:               companyName,
      slug,
      owner_id:           "00000000-0000-0000-0000-000000000000",
      vertical,
      vertical_id:        verticalId,
      contact_name:       contactName,
      contact_email:      gmailEmail,
      onboarding_status:  "gmail_connected",
    };

    let org;
    const { data: org1, error: orgError1 } = await supabase
      .from("organizations")
      .insert(insertOrg)
      .select()
      .single();

    if (orgError1) {
      // Slug collision — make it unique
      const { data: org2, error: orgError2 } = await supabase
        .from("organizations")
        .insert({ ...insertOrg, slug: `${slug}-${Date.now().toString(36)}` })
        .select()
        .single();

      if (orgError2) throw new Error(`Failed to create organisation: ${orgError2.message}`);
      org = org2;
    } else {
      org = org1;
    }

    return await finalize(
      supabase, org,
      gmailEmail, refreshToken, accessToken, tokenExpiresAt, scopes,
      vertical, companyName,
    );

  } catch (err) {
    console.error("Onboarding callback error:", err);
    return txt(`Something went wrong: ${(err as Error).message}\n\nPlease contact support@shortlisted.co.za`, 500);
  }
}

// Existing user re-auth: update/insert token, update all their routes
async function finalizeExisting(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  orgId: string,
  routeIds: string[],
  gmailEmail: string,
  refreshToken: string,
  accessToken: string,
  tokenExpiresAt: string,
  scopes: string[],
  vertical: string,
  orgName: string,
): Promise<Response> {
  // Upsert org_gmail_tokens (one per org)
  const { data: gmailToken, error: tokenError } = await supabase
    .from("org_gmail_tokens")
    .upsert({
      organization_id: orgId,
      gmail_email:     gmailEmail,
      refresh_token:   refreshToken,
      access_token:    accessToken,
      token_expires_at: tokenExpiresAt,
      scopes,
    }, { onConflict: "organization_id" })
    .select()
    .single();

  if (tokenError) throw new Error(`Failed to save Gmail token: ${tokenError.message}`);

  // Update all existing routes for this email to use the new token
  const { error: routeError } = await supabase
    .from("inbound_email_routes")
    .update({ gmail_token_id: gmailToken.id })
    .in("id", routeIds);

  if (routeError) throw new Error(`Failed to update email routes: ${routeError.message}`);

  // Mark org active
  await supabase
    .from("organizations")
    .update({ onboarding_status: "active" })
    .eq("id", orgId);

  const verticalLabel = VERTICALS[vertical] || vertical;
  console.log(`Re-authed: ${gmailEmail} | ${orgName} | ${routeIds.length} routes updated`);

  return txt(
`Shortlisted — Connected Successfully
=====================================

Gmail reconnected for your existing account.

  Inbox:    ${gmailEmail}
  Company:  ${orgName}
  Industry: ${verticalLabel}
  Routes:   ${routeIds.length} inbox(es) updated

CVs sent to your inbox will be automatically screened every night.

Questions? Email support@shortlisted.co.za
`);
}

async function finalize(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  // deno-lint-ignore no-explicit-any
  org: any,
  gmailEmail: string,
  refreshToken: string,
  accessToken: string,
  tokenExpiresAt: string,
  scopes: string[],
  vertical: string,
  companyName: string,
): Promise<Response> {
  // Create org_gmail_tokens row
  const { data: gmailToken, error: tokenError } = await supabase
    .from("org_gmail_tokens")
    .insert({
      organization_id: org.id,
      gmail_email:     gmailEmail,
      refresh_token:   refreshToken,
      access_token:    accessToken,
      token_expires_at: tokenExpiresAt,
      scopes,
    })
    .select()
    .single();

  if (tokenError) throw new Error(`Failed to save Gmail token: ${tokenError.message}`);

  // Create inbound_email_routes row
  const { error: routeError } = await supabase
    .from("inbound_email_routes")
    .insert({
      source_email:    gmailEmail,
      user_id:         org.owner_id,
      organization_id: org.id,
      gmail_token_id:  gmailToken.id,
      inbox_tz_id:     "Africa/Johannesburg",
    });

  if (routeError) throw new Error(`Failed to create email route: ${routeError.message}`);

  // ---- Invite client to Supabase Auth so they can access the config dashboard ----
  let invitedUserId: string | null = null;
  try {
    const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
      gmailEmail,
      {
        data: {
          org_id:    org.id,
          org_name:  companyName,
          vertical,
        },
      },
    );

    if (inviteError) {
      // Non-fatal — Gmail connection is the critical step
      console.error(`Auth invite failed for ${gmailEmail}: ${inviteError.message}`);
    } else if (inviteData?.user) {
      invitedUserId = inviteData.user.id;
      console.log(`Auth invite sent: ${gmailEmail} -> user ${invitedUserId}`);
    }
  } catch (inviteErr) {
    console.error(`Auth invite exception: ${(inviteErr as Error).message}`);
  }

  // Update owner_id + route user_id to the real Auth user ID
  if (invitedUserId) {
    await supabase
      .from("organizations")
      .update({ owner_id: invitedUserId })
      .eq("id", org.id);

    await supabase
      .from("inbound_email_routes")
      .update({ user_id: invitedUserId })
      .eq("organization_id", org.id);
  }

  // Mark org as active
  await supabase
    .from("organizations")
    .update({ onboarding_status: "active" })
    .eq("id", org.id);

  const verticalLabel = VERTICALS[vertical] || vertical;
  console.log(`Onboarded: ${gmailEmail} | ${companyName} | ${vertical}`);

  return txt(
`Shortlisted — Connected Successfully
=====================================

Your Gmail inbox is now connected.

  Inbox:    ${gmailEmail}
  Company:  ${companyName}
  Industry: ${verticalLabel}

CVs sent to your inbox will be screened every night and qualified
candidates will appear in your dashboard scored and ranked.

${invitedUserId ? "A dashboard login link has been sent to your email address.\n" : ""}
Questions? Email support@shortlisted.co.za
`);
}

// ============================================================================
// Mode 3: Index page — plain-text list of per-vertical links
// ============================================================================

function renderIndex(): Response {
  const lines = Object.entries(VERTICALS).map(
    ([value, label]) => `  ${label}\n  ${FUNCTION_URL}?vertical=${value}`,
  ).join("\n\n");

  return txt(
`Shortlisted — Connect Your Recruitment Inbox
=============================================

Send your client the link for their industry.
They click it, authorise Gmail, and they are live.

${lines}

Questions? support@shortlisted.co.za
`);
}

// ============================================================================
// Entry Point
// ============================================================================

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "GET") {
    return txt("Method not allowed", 405);
  }

  // Mode 2: Google OAuth callback
  if (url.searchParams.has("code") || url.searchParams.has("error")) {
    return await handleCallback(url);
  }

  // Mode 1: Start OAuth for a specific vertical
  const vertical = url.searchParams.get("vertical");
  if (vertical && vertical in VERTICALS) {
    return startOAuth(vertical);
  }

  // Mode 3: Index — show all vertical links
  return renderIndex();
});
