"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function addGlobalBrainEntry(formData: FormData) {
  const title = String(formData.get("title") || "").trim();
  const content = String(formData.get("content") || "").trim();
  const category = String(formData.get("category") || "rule");
  const priority = Math.min(Math.max(Number(formData.get("priority") || 50), 0), 100);

  if (!title || content.length < 10) {
    redirect("/brain?error=Title%20and%20meaningful%20content%20are%20required");
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("global_brain_entries").insert({
    owner_id: ownerId,
    category,
    title,
    content,
    priority,
    active: true,
  });

  if (error) redirect(`/brain?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/brain");
  redirect("/brain?message=Global%20Brain%20entry%20added");
}

export async function toggleGlobalBrainEntry(id: string, active: boolean) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("global_brain_entries")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", ownerId);

  if (error) redirect(`/brain?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/brain");
  redirect("/brain");
}
