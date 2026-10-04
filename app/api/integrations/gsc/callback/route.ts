import { NextRequest, NextResponse } from "next/server";
import { encryptCredential } from "@/lib/security/credential-crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type SearchConsoleSitesResponse = {
  siteEntry?: Array<{
    siteUrl?: string;
    permissionLevel?: string;
  }>;
};

function redirectProject(request: NextRequest, projectId: string, key: "error" | "message", value: string) {
  const url = new URL(`/projects/${projectId}`, request.url);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");

  if (!state) {
    return NextResponse.redirect(new URL("/projects?error=Missing%20OAuth%20state", request.url));
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: oauthState } = await supabase
    .from("oauth_states")
    .select("state,project_id,expires_at")
    .eq("state", state)
    .eq("owner_id", ownerId)
    .eq("provider", "gsc")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!oauthState) {
    return NextResponse.redirect(new URL("/projects?error=OAuth%20state%20expired%20or%20invalid", request.url));
  }

  const projectId = oauthState.project_id;

  if (oauthError || !code) {
    await supabase.from("oauth_states").delete().eq("state", state);
    return redirectProject(request, projectId, "error", oauthError || "Google authorization was cancelled.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = (process.env.APP_URL || request.nextUrl.origin).replace(/\/$/, "");

  if (!clientId || !clientSecret) {
    return redirectProject(request, projectId, "error", "Google OAuth server credentials are not configured.");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${appUrl}/api/integrations/gsc/callback`,
    }),
    cache: "no-store",
  });

  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;

  if (!tokenResponse.ok || !tokens.access_token) {
    await supabase.from("oauth_states").delete().eq("state", state);
    return redirectProject(
      request,
      projectId,
      "error",
      tokens.error_description || tokens.error || "Google token exchange failed.",
    );
  }

  const sitesResponse = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
  });

  const sites = (await sitesResponse.json()) as SearchConsoleSitesResponse;
  if (!sitesResponse.ok) {
    await supabase.from("oauth_states").delete().eq("state", state);
    return redirectProject(request, projectId, "error", "Connected to Google but could not list Search Console properties.");
  }

  const availableSites = (sites.siteEntry || [])
    .filter((site) => Boolean(site.siteUrl))
    .map((site) => ({
      siteUrl: site.siteUrl!,
      permissionLevel: site.permissionLevel || "unknown",
    }));

  const scopes = (tokens.scope || GSC_SCOPE).split(" ").filter(Boolean);
  const selectedResource = availableSites.length === 1 ? availableSites[0].siteUrl : null;

  const { data: integration, error: integrationError } = await supabase
    .from("project_integrations")
    .upsert(
      {
        project_id: projectId,
        owner_id: ownerId,
        provider: "gsc",
        status: "connected",
        selected_resource: selectedResource,
        scopes,
        config: { available_sites: availableSites },
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,provider" },
    )
    .select("id")
    .single();

  if (integrationError || !integration) {
    await supabase.from("oauth_states").delete().eq("state", state);
    return redirectProject(request, projectId, "error", integrationError?.message || "Could not save GSC integration.");
  }

  try {
    const admin = createAdminClient();
    const { data: existingCredential } = await admin
      .from("integration_credentials")
      .select("encrypted_refresh_token")
      .eq("integration_id", integration.id)
      .maybeSingle();

    const encryptedRefreshToken = tokens.refresh_token
      ? encryptCredential(tokens.refresh_token)
      : existingCredential?.encrypted_refresh_token;

    if (!encryptedRefreshToken) {
      await supabase
        .from("project_integrations")
        .update({ status: "error", last_error: "Google did not return a refresh token." })
        .eq("id", integration.id);
      await supabase.from("oauth_states").delete().eq("state", state);
      return redirectProject(
        request,
        projectId,
        "error",
        "Google did not return a refresh token. Reconnect and approve offline access.",
      );
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const { error: credentialError } = await admin
      .from("integration_credentials")
      .upsert({
        integration_id: integration.id,
        project_id: projectId,
        owner_id: ownerId,
        provider: "gsc",
        encrypted_access_token: encryptCredential(tokens.access_token),
        encrypted_refresh_token: encryptedRefreshToken,
        expires_at: expiresAt,
        token_type: tokens.token_type || "Bearer",
        scopes,
        updated_at: new Date().toISOString(),
      });

    if (credentialError) throw credentialError;
  } catch (error) {
    await supabase
      .from("project_integrations")
      .update({
        status: "error",
        last_error: error instanceof Error ? error.message : "Credential storage failed.",
      })
      .eq("id", integration.id);

    await supabase.from("oauth_states").delete().eq("state", state);
    return redirectProject(request, projectId, "error", "GSC authorized, but secure credential storage is not configured.");
  }

  await supabase.from("oauth_states").delete().eq("state", state);

  return redirectProject(
    request,
    projectId,
    "message",
    availableSites.length
      ? `Google Search Console connected. ${availableSites.length} property/properties found.`
      : "Google Search Console connected, but no accessible properties were found.",
  );
}
