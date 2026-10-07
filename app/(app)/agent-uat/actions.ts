"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAgentUatScenario } from "@/lib/agents/uat";
import { getAgentUatScenario } from "@/lib/agents/uat-scenarios";
import { createClient } from "@/lib/supabase/server";

export async function runAgentUatAction(formData: FormData) {
  const projectId = String(formData.get("projectId") || "").trim();
  const scenarioKey = String(formData.get("scenarioKey") || "").trim();

  if (!projectId || !scenarioKey) {
    redirect("/agent-uat?error=Project%20and%20scenario%20are%20required");
  }

  const scenario = getAgentUatScenario(scenarioKey);
  if (!scenario) {
    redirect(
      "/agent-uat?project=" +
        encodeURIComponent(projectId) +
        "&error=Unknown%20UAT%20scenario",
    );
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (claimsError || !ownerId) redirect("/login");

  try {
    const result = await runAgentUatScenario({
      client: supabase,
      ownerId,
      projectId,
      scenario,
    });

    revalidatePath("/agent-uat");
    revalidatePath("/agents");
    revalidatePath("/costs");

    redirect(
      "/agent-uat?project=" +
        encodeURIComponent(projectId) +
        "&agent=" +
        encodeURIComponent(scenario.expectedAgentKey) +
        "&run=" +
        encodeURIComponent(result.uatRunId) +
        "&message=" +
        encodeURIComponent(
          "UAT " + result.status + " · " + String(result.score) + "/100",
        ),
    );
  } catch (error) {
    redirect(
      "/agent-uat?project=" +
        encodeURIComponent(projectId) +
        "&agent=" +
        encodeURIComponent(scenario.expectedAgentKey) +
        "&error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "Agent UAT failed",
        ),
    );
  }
}
