import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function projectRedirect(request: NextRequest, projectId: string, message: string) {
  const url = new URL(`/projects/${projectId}`, request.url);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return projectRedirect(request, projectId, "GOOGLE_CLIENT_ID is not configured yet.");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();

  if (!project) {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { error: stateError } = await supabase.from("oauth_states").insert({
    state,
    project_id: projectId,
    owner_id: ownerId,
    provider: "gsc",
    redirect_path: `/projects/${projectId}`,
    expires_at: expiresAt,
  });

  if (stateError) {
    return projectRedirect(request, projectId, stateError.message);
  }

  const appUrl = (process.env.APP_URL || request.nextUrl.origin).replace(/\/$/, "");
  const redirectUri = `${appUrl}/api/integrations/gsc/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
