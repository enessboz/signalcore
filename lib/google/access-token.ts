import { decryptCredential, encryptCredential } from "@/lib/security/credential-crypto";
import { createClient } from "@/lib/supabase/server";

type CredentialRow = {
  connection_id: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  expires_at: string | null;
};

export async function getGoogleAccessToken() {
  const supabase = await createClient();

  const { data: connection, error: connectionError } = await supabase
    .from("connections")
    .select("id,status")
    .eq("provider", "google")
    .eq("status", "connected")
    .maybeSingle();

  if (connectionError || !connection) {
    throw new Error("Google account is not connected.");
  }

  const { data: credential, error: credentialError } = await supabase
    .from("connection_credentials")
    .select("connection_id,encrypted_access_token,encrypted_refresh_token,expires_at")
    .eq("connection_id", connection.id)
    .maybeSingle<CredentialRow>();

  if (credentialError || !credential) {
    throw new Error("Google credentials are unavailable. Reconnect Google in Settings.");
  }

  const stillValid =
    credential.encrypted_access_token &&
    credential.expires_at &&
    new Date(credential.expires_at).getTime() > Date.now() + 2 * 60 * 1000;

  if (stillValid) {
    return {
      accessToken: decryptCredential(credential.encrypted_access_token!),
      connectionId: connection.id,
    };
  }

  if (!credential.encrypted_refresh_token) {
    throw new Error("Google refresh token is missing. Reconnect Google in Settings.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth server credentials are not configured.");
  }

  const refreshToken = decryptCredential(credential.encrypted_refresh_token);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description || payload.error || "Google token refresh failed.",
    );
  }

  const expiresAt = payload.expires_in
    ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
    : null;

  const { error: updateError } = await supabase
    .from("connection_credentials")
    .update({
      encrypted_access_token: encryptCredential(payload.access_token),
      expires_at: expiresAt,
      token_type: payload.token_type || "Bearer",
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", connection.id);

  if (updateError) {
    throw new Error(`Google token refreshed but could not be persisted: ${updateError.message}`);
  }

  return {
    accessToken: payload.access_token,
    connectionId: connection.id,
  };
}
