import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl = (process.env.APP_URL || request.nextUrl.origin).replace(/\/$/, "");

  if (!clientId) {
    const url = new URL("/settings", request.url);
    url.searchParams.set("error", "GOOGLE_CLIENT_ID is not configured yet.");
    return NextResponse.redirect(url);
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { error: stateError } = await supabase.from("account_oauth_states").insert({
    state,
    owner_id: ownerId,
    provider: "google",
    redirect_path: "/settings",
    requested_scopes: GOOGLE_SCOPES,
    expires_at: expiresAt,
  });

  if (stateError) {
    const url = new URL("/settings", request.url);
    url.searchParams.set("error", stateError.message);
    return NextResponse.redirect(url);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${appUrl}/api/connections/google/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    state,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
