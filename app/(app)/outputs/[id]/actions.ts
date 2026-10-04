"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function requestOutputApproval(outputId: string) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: output, error } = await supabase
    .from("generated_outputs")
    .select("id,project_id,title,output_type,status")
    .eq("id", outputId)
    .eq("owner_id", ownerId)
    .single();

  if (error || !output) {
    redirect("/outputs?error=Output%20not%20found");
  }

  if (output.status === "approved") {
    redirect("/outputs/" + output.id + "?message=Output%20is%20already%20approved");
  }

  const { data: existing } = await supabase
    .from("approvals")
    .select("id,status,execution_status,payload")
    .eq("project_id", output.project_id)
    .eq("owner_id", ownerId)
    .eq("action_type", "approve_output")
    .in("status", ["pending", "approved"])
    .order("requested_at", { ascending: false })
    .limit(50);

  const duplicate = (existing || []).find((approval) => {
    const payload = (approval.payload || {}) as Record<string, unknown>;
    return String(payload.target || "") === output.id;
  });

  if (duplicate) {
    redirect(
      "/approvals?status=" +
        duplicate.status +
        "&message=Approval%20request%20already%20exists",
    );
  }

  const { error: insertError } = await supabase.from("approvals").insert({
    project_id: output.project_id,
    owner_id: ownerId,
    action_type: "approve_output",
    status: "pending",
    payload: {
      title: "Approve " + output.output_type + ": " + output.title,
      summary:
        "Approve this generated SignalCore output for use as an accepted deliverable.",
      target: output.id,
      instructions:
        "Mark the referenced generated output as approved after explicit human approval.",
      source: "output_detail",
    },
    summary: "Approve generated output: " + output.title,
    risk_level: "low",
    execution_status: "not_started",
  });

  if (insertError) {
    redirect(
      "/outputs/" +
        output.id +
        "?error=" +
        encodeURIComponent(insertError.message),
    );
  }

  redirect("/approvals?status=pending&message=Output%20approval%20requested");
}
