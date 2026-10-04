"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function parseConfig(formData: FormData) {
  const raw = String(formData.get("config") || "{}");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function saveGa4View(projectId: string, formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  const config = parseConfig(formData);
  if (!name || !config) {
    redirect(`/projects/${projectId}/analytics?error=Valid%20view%20name%20and%20configuration%20are%20required`);
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("saved_analytics_views").insert({
    project_id: projectId,
    owner_id: ownerId,
    data_source: "ga4",
    name,
    config,
  });

  if (error) {
    redirect(`/projects/${projectId}/analytics?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/projects/${projectId}/analytics?message=GA4%20view%20saved`);
}

export async function saveGa4Funnel(projectId: string, formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  const config = parseConfig(formData);
  if (!name || !config) {
    redirect(`/projects/${projectId}/analytics?mode=funnel&error=Valid%20funnel%20name%20and%20configuration%20are%20required`);
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("ga4_funnels").insert({
    project_id: projectId,
    owner_id: ownerId,
    name,
    config,
  });

  if (error) {
    redirect(`/projects/${projectId}/analytics?mode=funnel&error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/projects/${projectId}/analytics?mode=funnel&message=Funnel%20saved`);
}
