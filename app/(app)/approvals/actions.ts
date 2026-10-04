"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { executeApprovedAction } from "@/lib/approvals/executors";

async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected" | "cancelled",
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: approval, error: approvalError } = await supabase
    .from("approvals")
    .select("id,project_id,action_type,status,risk_level,target_agent_key,payload")
    .eq("id", approvalId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (approvalError || !approval) {
    redirect(`/approvals?error=${encodeURIComponent(approvalError?.message || "Approval not found")}`);
  }

  if (approval.status !== "pending") {
    redirect("/approvals?error=Only%20pending%20approvals%20can%20be%20decided");
  }

  const executionStatus = decision === "approved" ? "ready" : "cancelled";
  const { error } = await supabase
    .from("approvals")
    .update({
      status: decision,
      execution_status: executionStatus,
      decided_at: new Date().toISOString(),
    })
    .eq("id", approval.id)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(`/approvals?error=${encodeURIComponent(error.message)}`);
  }

  await supabase.from("audit_events").insert({
    project_id: approval.project_id,
    owner_id: ownerId,
    actor_type: "user",
    event_type: `approval_${decision}`,
    entity_type: "approval",
    entity_id: approval.id,
    metadata: {
      action_type: approval.action_type,
      risk_level: approval.risk_level,
      target_agent_key: approval.target_agent_key,
    },
  });

  revalidatePath("/approvals");
  revalidatePath("/team");
  redirect(`/approvals?status=${decision === "approved" ? "approved" : decision}&message=${encodeURIComponent(`Approval ${decision}`)}`);
}

export async function approveAction(approvalId: string) {
  return decideApproval(approvalId, "approved");
}

export async function rejectAction(approvalId: string) {
  return decideApproval(approvalId, "rejected");
}

export async function cancelAction(approvalId: string) {
  return decideApproval(approvalId, "cancelled");
}


export async function executeAction(approvalId: string) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  try {
    await executeApprovedAction({
      ownerId,
      approvalId,
      client: supabase,
    });
    revalidatePath("/approvals");
    revalidatePath("/outputs");
    redirect("/approvals?status=approved&message=Action%20executed");
  } catch (error) {
    redirect(
      `/approvals?status=approved&error=${encodeURIComponent(
        error instanceof Error ? error.message : "Execution failed",
      )}`,
    );
  }
}
