"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function setFindingStatus(
  findingId: string,
  status: "open" | "monitoring" | "resolved" | "dismissed",
  returnTo = "/opportunities",
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("findings")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", findingId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(`${returnTo}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/opportunities");
  redirect(`${returnTo}?message=${encodeURIComponent(`Finding marked ${status}`)}`);
}
