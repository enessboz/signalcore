"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createOutputProfile(formData: FormData) {
  const name = text(formData, "name");
  const outputType = text(formData, "outputType");
  const description = text(formData, "description");
  const rulesText = text(formData, "rules");
  const strictMode = formData.get("strictMode") === "on";
  const isDefault = formData.get("isDefault") === "on";

  if (!name || !["summary","document","presentation","task","email"].includes(outputType)) {
    redirect("/output-profiles?error=Name%20and%20valid%20output%20type%20are%20required");
  }

  let rules: Record<string, unknown>;
  try {
    rules = rulesText ? JSON.parse(rulesText) as Record<string, unknown> : {};
  } catch {
    redirect("/output-profiles?error=Rules%20must%20be%20valid%20JSON");
  }

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  if (isDefault) {
    await supabase
      .from("output_profiles")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("owner_id", ownerId)
      .eq("output_type", outputType);
  }

  const keyBase = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "profile";

  const { error } = await supabase.from("output_profiles").insert({
    owner_id: ownerId,
    profile_key: keyBase + "-" + crypto.randomUUID().slice(0, 8),
    name,
    output_type: outputType,
    description: description || null,
    strict_mode: strictMode,
    is_default: isDefault,
    active: true,
    rules,
  });

  if (error) redirect(`/output-profiles?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/output-profiles");
  redirect("/output-profiles?message=Output%20profile%20created");
}

export async function setDefaultOutputProfile(profileId: string) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: profile, error } = await supabase
    .from("output_profiles")
    .select("id,output_type")
    .eq("id", profileId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error || !profile) {
    redirect(`/output-profiles?error=${encodeURIComponent(error?.message || "Profile not found")}`);
  }

  await supabase
    .from("output_profiles")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("output_type", profile.output_type);

  const { error: updateError } = await supabase
    .from("output_profiles")
    .update({ is_default: true, active: true, updated_at: new Date().toISOString() })
    .eq("id", profile.id)
    .eq("owner_id", ownerId);

  if (updateError) {
    redirect(`/output-profiles?error=${encodeURIComponent(updateError.message)}`);
  }

  revalidatePath("/output-profiles");
  redirect("/output-profiles?message=Default%20profile%20updated");
}

export async function toggleOutputProfile(profileId: string, active: boolean) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("output_profiles")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .eq("owner_id", ownerId);

  if (error) redirect(`/output-profiles?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/output-profiles");
  redirect("/output-profiles");
}

export async function assignProjectOutputProfile(formData: FormData) {
  const projectId = text(formData, "projectId");
  const outputType = text(formData, "outputType");
  const profileId = text(formData, "profileId");

  if (!projectId || !outputType) {
    redirect("/output-profiles?error=Project%20and%20output%20type%20are%20required");
  }

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  if (!profileId) {
    const { error } = await supabase
      .from("project_output_profiles")
      .delete()
      .eq("project_id", projectId)
      .eq("owner_id", ownerId)
      .eq("output_type", outputType);

    if (error) redirect(`/output-profiles?error=${encodeURIComponent(error.message)}`);
    redirect("/output-profiles?message=Project%20override%20removed");
  }

  const { data: profile } = await supabase
    .from("output_profiles")
    .select("id,output_type")
    .eq("id", profileId)
    .eq("owner_id", ownerId)
    .eq("active", true)
    .maybeSingle();

  if (!profile || profile.output_type !== outputType) {
    redirect("/output-profiles?error=Selected%20profile%20does%20not%20match%20output%20type");
  }

  const { error } = await supabase.from("project_output_profiles").upsert(
    {
      project_id: projectId,
      owner_id: ownerId,
      output_type: outputType,
      profile_id: profileId,
    },
    { onConflict: "project_id,output_type" },
  );

  if (error) redirect(`/output-profiles?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/output-profiles");
  redirect("/output-profiles?message=Project%20output%20profile%20assigned");
}
