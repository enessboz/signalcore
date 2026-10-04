"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function saveBudgetLimit(formData: FormData) {
  const projectId = String(formData.get("projectId") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const monthlyLimit = Number(String(formData.get("monthlyLimit") || "0"));
  const softWarningPercent = Number(String(formData.get("softWarningPercent") || "80"));
  const hardStop = formData.get("hardStop") === "on";

  if (
    !projectId ||
    !["ai", "serp", "browser"].includes(category) ||
    !Number.isFinite(monthlyLimit) ||
    monthlyLimit < 0 ||
    !Number.isFinite(softWarningPercent) ||
    softWarningPercent < 1 ||
    softWarningPercent > 100
  ) {
    redirect("/costs?error=Invalid%20budget%20configuration");
  }

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("budget_limits").upsert(
    {
      project_id: projectId,
      owner_id: ownerId,
      category,
      monthly_limit: monthlyLimit,
      soft_warning_percent: Math.round(softWarningPercent),
      hard_stop: hardStop,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,category" },
  );

  if (error) {
    redirect(`/costs?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/costs");
  revalidatePath("/readiness");
  redirect("/costs?message=Budget%20saved");
}

export async function removeBudgetLimit(projectId: string, category: string) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("budget_limits")
    .delete()
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .eq("category", category);

  if (error) {
    redirect(`/costs?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/costs");
  revalidatePath("/readiness");
  redirect("/costs?message=Budget%20removed");
}
