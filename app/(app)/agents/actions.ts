"use server";

import { redirect } from "next/navigation";
import { executeAgentTask } from "@/lib/agents/runtime";
import { createClient } from "@/lib/supabase/server";

export async function runAgentAction(formData: FormData) {
  const projectId = String(formData.get("projectId") || "").trim();
  const agentKey = String(formData.get("agentKey") || "auto").trim();
  const request = String(formData.get("request") || "").trim();

  if (!projectId || request.length < 10) {
    redirect("/agents?error=Choose%20a%20project%20and%20enter%20a%20clear%20task");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) redirect("/login");

  try {
    const runId = await executeAgentTask({
      ownerId,
      projectId,
      selectedAgentKey: agentKey,
      userRequest: request,
    });

    redirect(
      `/agents?project=${encodeURIComponent(projectId)}&run=${encodeURIComponent(runId)}&message=Agent%20run%20completed`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    redirect(
      `/agents?project=${encodeURIComponent(projectId)}&error=${encodeURIComponent(message)}`,
    );
  }
}
