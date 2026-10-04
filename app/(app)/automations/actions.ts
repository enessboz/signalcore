"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function setScheduledTaskStatus(
  taskId: string,
  status: "active" | "paused" | "cancelled",
) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("scheduled_tasks")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId)
    .eq("owner_id", ownerId);

  if (error) redirect(`/automations?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/automations");
  revalidatePath("/team");
  redirect(`/automations?message=${encodeURIComponent(`Scheduled task ${status}`)}`);
}
