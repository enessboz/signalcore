"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { executeAgentTask } from "@/lib/agents/runtime";
import { createClient } from "@/lib/supabase/server";

export async function acceptHandoff(handoffId: string) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: handoff, error } = await supabase
    .from("agent_handoffs")
    .select("id,project_id,from_run_id,to_agent_key,reason,status")
    .eq("id", handoffId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error || !handoff) {
    redirect(`/team?error=${encodeURIComponent(error?.message || "Handoff not found")}`);
  }

  if (!handoff.project_id) {
    redirect("/team?error=Handoff%20has%20no%20project");
  }

  const { data: sourceRun, error: sourceError } = await supabase
    .from("agent_runs")
    .select("user_request")
    .eq("id", handoff.from_run_id)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (sourceError || !sourceRun) {
    redirect(`/team?error=${encodeURIComponent(sourceError?.message || "Source run not found")}`);
  }

  await supabase
    .from("agent_handoffs")
    .update({ status: "accepted" })
    .eq("id", handoff.id)
    .eq("owner_id", ownerId);

  try {
    await executeAgentTask({
      ownerId,
      projectId: handoff.project_id,
      selectedAgentKey: handoff.to_agent_key,
      userRequest: `${sourceRun.user_request}\n\nHANDOFF CONTEXT:\n${handoff.reason}`,
      triggerType: "handoff",
    });

    await supabase
      .from("agent_handoffs")
      .update({ status: "completed" })
      .eq("id", handoff.id)
      .eq("owner_id", ownerId);

    revalidatePath("/team");
    redirect("/team?message=Handoff%20completed");
  } catch (runError) {
    await supabase
      .from("agent_handoffs")
      .update({ status: "proposed" })
      .eq("id", handoff.id)
      .eq("owner_id", ownerId);

    redirect(
      `/team?error=${encodeURIComponent(
        runError instanceof Error ? runError.message : "Handoff execution failed",
      )}`,
    );
  }
}

export async function rejectHandoff(handoffId: string) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("agent_handoffs")
    .update({ status: "rejected" })
    .eq("id", handoffId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(`/team?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/team");
  redirect("/team?message=Handoff%20rejected");
}
