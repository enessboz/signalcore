"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function saveGscView(projectId: string, formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  const configRaw = String(formData.get("config") || "{}");

  if (!name) {
    redirect(`/projects/${projectId}/search-console?error=Saved%20view%20name%20is%20required`);
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch {
    redirect(`/projects/${projectId}/search-console?error=Invalid%20view%20configuration`);
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("saved_analytics_views").insert({
    project_id: projectId,
    owner_id: ownerId,
    data_source: "gsc",
    name,
    config,
  });

  if (error) {
    redirect(`/projects/${projectId}/search-console?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/projects/${projectId}/search-console?message=Search%20Console%20view%20saved`);
}
