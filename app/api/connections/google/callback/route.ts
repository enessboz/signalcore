import { NextRequest, NextResponse } from "next/server";
import { encryptCredential } from "@/lib/security/credential-crypto";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfo = {
  email?: string;
};

type GscSitesResponse = {
  siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  error?: { message?: string };
};

type GaAccountSummariesResponse = {
  accountSummaries?: Array<{
    account?: string;
    displayName?: string;
    propertySummaries?: Array<{
      property?: string;
      displayName?: string;
      propertyType?: string;
      parent?: string;
    }>;
  }>;
  nextPageToken?: string;
  error?: { message?: string };
};

function settingsRedirect(
  request: NextRequest,
  key: "error" | "message",
  value: string,
) {
  const url = new URL("/settings", request.url);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

async function discoverGsc(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const body = (await response.json()) as GscSitesResponse;

  if (!response.ok) {
    throw new Error(body.error?.message || "Search Console property discovery failed.");
  }

  return (body.siteEntry || [])
    .filter((site) => Boolean(site.siteUrl))
    .map((site) => ({
      resource_type: "gsc_property" as const,
      resource_id: site.siteUrl!,
      display_name: site.siteUrl!,
      parent_id: null,
      permission_level: site.permissionLevel || null,
      metadata: {},
    }));
}

async function discoverGa4(accessToken: string) {
  const resources: Array<{
    resource_type: "ga4_property";
    resource_id: string;
    display_name: string;
    parent_id: string | null;
    permission_level: null;
    metadata: Record<string, string | null>;
  }> = [];

  let pageToken = "";

  do {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const body = (await response.json()) as GaAccountSummariesResponse;

    if (!response.ok) {
      throw new Error(body.error?.message || "Google Analytics property discovery failed.");
    }

    for (const account of body.accountSummaries || []) {
      for (const property of account.propertySummaries || []) {
        if (!property.property) continue;
        resources.push({
          resource_type: "ga4_property",
          resource_id: property.property,
          display_name: property.displayName || property.property,
          parent_id: account.account || null,
          permission_level: null,
          metadata: {
            account_display_name: account.displayName || null,
            property_type: property.propertyType || null,
            parent: property.parent || null,
          },
        });
      }
    }

    pageToken = body.nextPageToken || "";
  } while (pageToken);

  return resources;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");

  if (!state) {
    return settingsRedirect(request, "error", "Missing Google OAuth state.");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: oauthState } = await supabase
    .from("account_oauth_states")
    .select("state,expires_at")
    .eq("state", state)
    .eq("owner_id", ownerId)
    .eq("provider", "google")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!oauthState) {
    return settingsRedirect(request, "error", "Google OAuth state expired or is invalid.");
  }

  if (oauthError || !code) {
    await supabase.from("account_oauth_states").delete().eq("state", state);
    return settingsRedirect(
      request,
      "error",
      oauthError || "Google authorization was cancelled.",
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = (process.env.APP_URL || request.nextUrl.origin).replace(/\/$/, "");

  if (!clientId || !clientSecret || !process.env.CREDENTIAL_ENCRYPTION_KEY) {
    return settingsRedirect(
      request,
      "error",
      "Google OAuth server credentials are not fully configured.",
    );
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${appUrl}/api/connections/google/callback`,
    }),
    cache: "no-store",
  });

  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;

  if (!tokenResponse.ok || !tokens.access_token) {
    await supabase.from("account_oauth_states").delete().eq("state", state);
    return settingsRedirect(
      request,
      "error",
      tokens.error_description || tokens.error || "Google token exchange failed.",
    );
  }

  let email: string | null = null;
  try {
    const userInfoResponse = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        cache: "no-store",
      },
    );
    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as GoogleUserInfo;
      email = userInfo.email || null;
    }
  } catch {
    // Email is optional; resource discovery can continue without it.
  }

  const scopes = (tokens.scope || "").split(" ").filter(Boolean);

  const { data: connection, error: connectionError } = await supabase
    .from("connections")
    .upsert(
      {
        owner_id: ownerId,
        provider: "google",
        status: "connecting",
        external_account: email,
        scopes,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,provider" },
    )
    .select("id")
    .single();

  if (connectionError || !connection) {
    await supabase.from("account_oauth_states").delete().eq("state", state);
    return settingsRedirect(
      request,
      "error",
      connectionError?.message || "Could not create Google connection.",
    );
  }

  const { data: existingCredential } = await supabase
    .from("connection_credentials")
    .select("encrypted_refresh_token")
    .eq("connection_id", connection.id)
    .maybeSingle();

  const encryptedRefreshToken = tokens.refresh_token
    ? encryptCredential(tokens.refresh_token)
    : existingCredential?.encrypted_refresh_token || null;

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { error: credentialError } = await supabase
    .from("connection_credentials")
    .upsert({
      connection_id: connection.id,
      owner_id: ownerId,
      provider: "google",
      encrypted_access_token: encryptCredential(tokens.access_token),
      encrypted_refresh_token: encryptedRefreshToken,
      expires_at: expiresAt,
      token_type: tokens.token_type || "Bearer",
      scopes,
      updated_at: new Date().toISOString(),
    });

  if (credentialError) {
    await supabase
      .from("connections")
      .update({ status: "error", last_error: credentialError.message })
      .eq("id", connection.id);
    await supabase.from("account_oauth_states").delete().eq("state", state);
    return settingsRedirect(request, "error", "Could not securely store Google credentials.");
  }

  const discoveryWarnings: string[] = [];
  let gscResources: Awaited<ReturnType<typeof discoverGsc>> = [];
  let ga4Resources: Awaited<ReturnType<typeof discoverGa4>> = [];

  try {
    gscResources = await discoverGsc(tokens.access_token);
  } catch (error) {
    discoveryWarnings.push(
      `GSC: ${error instanceof Error ? error.message : "Discovery failed"}`,
    );
  }

  try {
    ga4Resources = await discoverGa4(tokens.access_token);
  } catch (error) {
    discoveryWarnings.push(
      `GA4: ${error instanceof Error ? error.message : "Discovery failed"}`,
    );
  }

  await supabase
    .from("connection_resources")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("connection_id", connection.id);

  const discovered = [...gscResources, ...ga4Resources].map((resource) => ({
    connection_id: connection.id,
    owner_id: ownerId,
    ...resource,
    active: true,
    discovered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  if (discovered.length) {
    const { error: resourcesError } = await supabase
      .from("connection_resources")
      .upsert(discovered, {
        onConflict: "connection_id,resource_type,resource_id",
      });

    if (resourcesError) {
      discoveryWarnings.push(`Resources: ${resourcesError.message}`);
    }
  }

  const now = new Date().toISOString();
  await supabase
    .from("connections")
    .update({
      status: "connected",
      external_account: email,
      scopes,
      last_discovery_at: now,
      last_error: discoveryWarnings.length ? discoveryWarnings.join(" | ") : null,
      config: {
        gsc_count: gscResources.length,
        ga4_count: ga4Resources.length,
      },
      updated_at: now,
    })
    .eq("id", connection.id);

  await supabase.from("account_oauth_states").delete().eq("state", state);

  const message = `Google connected: ${gscResources.length} GSC and ${ga4Resources.length} GA4 properties discovered.`;
  return settingsRedirect(request, "message", message);
}
