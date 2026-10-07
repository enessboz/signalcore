import type { SupabaseClient } from "@supabase/supabase-js";
import { executeAgentTask } from "@/lib/agents/runtime";
import type { AgentUatScenario } from "@/lib/agents/uat-scenarios";

type SpecialistOutput = {
  summary?: string;
  findings?: Array<{
    title?: string;
    evidence_refs?: string[];
  }>;
  proposed_actions?: Array<Record<string, unknown>>;
  handoff?: {
    needed?: boolean;
    to_agent_key?: string | null;
  };
};

function scoreChecks(checks: Record<string, boolean>) {
  const weights: Record<string, number> = {
    correct_agent: 25,
    run_succeeded: 20,
    summary_present: 15,
    evidence_integrity: 20,
    approval_gate: 10,
    handoff_valid: 10,
  };

  return Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + (checks[key] ? weight : 0),
    0,
  );
}

export async function runAgentUatScenario(input: {
  client: SupabaseClient;
  ownerId: string;
  projectId: string;
  scenario: AgentUatScenario;
}) {
  const today = new Date();
  const dayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  ).toISOString();

  const { count: todayCount, error: countError } = await input.client
    .from("agent_uat_runs")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", input.ownerId)
    .eq("project_id", input.projectId)
    .gte("created_at", dayStart);

  if (countError) {
    throw new Error("UAT daily usage could not be checked: " + countError.message);
  }

  if ((todayCount || 0) >= 10) {
    throw new Error(
      "Daily Agent UAT safety limit reached for this project (10 runs/day). Continue tomorrow or review the existing results first.",
    );
  }

  const { data: uat, error: createError } = await input.client
    .from("agent_uat_runs")
    .insert({
      owner_id: input.ownerId,
      project_id: input.projectId,
      scenario_key: input.scenario.key,
      scenario_name: input.scenario.name,
      expected_agent_key: input.scenario.expectedAgentKey,
      execution_mode: input.scenario.mode,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (createError || !uat) {
    throw new Error(createError?.message || "UAT run could not be created.");
  }

  try {
    const runId = await executeAgentTask({
      ownerId: input.ownerId,
      projectId: input.projectId,
      selectedAgentKey:
        input.scenario.mode === "router"
          ? "auto"
          : input.scenario.expectedAgentKey,
      userRequest: input.scenario.request,
      triggerType: "manual",
      client: input.client,
    });

    const { data: run, error: runError } = await input.client
      .from("agent_runs")
      .select("id,agent_key,parent_run_id,status,output,actual_cost,error")
      .eq("id", runId)
      .eq("owner_id", input.ownerId)
      .eq("project_id", input.projectId)
      .single();

    if (runError || !run) {
      throw new Error(runError?.message || "Agent run could not be loaded.");
    }

    const output = (run.output || {}) as SpecialistOutput;
    const findings = Array.isArray(output.findings) ? output.findings : [];
    const proposedActions = Array.isArray(output.proposed_actions)
      ? output.proposed_actions
      : [];

    const { count: approvalCount, error: approvalError } = await input.client
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("agent_run_id", runId)
      .eq("owner_id", input.ownerId);

    if (approvalError) {
      throw new Error("UAT approval check failed: " + approvalError.message);
    }

    const { data: agentDefinitions, error: definitionError } = await input.client
      .from("agent_definitions")
      .select("agent_key")
      .in("status", ["testing", "active"]);

    if (definitionError) {
      throw new Error("UAT agent definitions could not be loaded: " + definitionError.message);
    }

    const validAgentKeys = new Set(
      (agentDefinitions || []).map((item) => item.agent_key),
    );
    const handoffNeeded = Boolean(output.handoff?.needed);
    const handoffTarget = output.handoff?.to_agent_key || null;

    let totalCost = Number(run.actual_cost || 0);
    if (run.parent_run_id) {
      const { data: parent } = await input.client
        .from("agent_runs")
        .select("actual_cost")
        .eq("id", run.parent_run_id)
        .eq("owner_id", input.ownerId)
        .maybeSingle();
      totalCost += Number(parent?.actual_cost || 0);
    }

    const checks: Record<string, boolean> = {
      correct_agent: run.agent_key === input.scenario.expectedAgentKey,
      run_succeeded: run.status === "succeeded",
      summary_present:
        typeof output.summary === "string" && output.summary.trim().length >= 20,
      evidence_integrity: findings.every(
        (finding) =>
          Array.isArray(finding.evidence_refs) &&
          finding.evidence_refs.length > 0,
      ),
      approval_gate:
        proposedActions.length === 0 ||
        Number(approvalCount || 0) >= proposedActions.length,
      handoff_valid:
        !handoffNeeded ||
        Boolean(handoffTarget && validAgentKeys.has(handoffTarget)),
    };

    const score = scoreChecks(checks);
    const criticalPass =
      checks.correct_agent &&
      checks.run_succeeded &&
      checks.evidence_integrity &&
      checks.approval_gate;
    const status = score >= 85 && criticalPass ? "passed" : "failed";

    const { error: finishError } = await input.client
      .from("agent_uat_runs")
      .update({
        actual_agent_key: run.agent_key,
        status,
        score,
        checks,
        agent_run_id: runId,
        actual_cost: totalCost,
        error: run.error || null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", uat.id)
      .eq("owner_id", input.ownerId);

    if (finishError) {
      throw new Error("UAT result could not be saved: " + finishError.message);
    }

    return {
      uatRunId: uat.id as string,
      agentRunId: runId,
      status,
      score,
      checks,
      totalCost,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent UAT failed.";

    await input.client
      .from("agent_uat_runs")
      .update({
        status: "error",
        error: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", uat.id)
      .eq("owner_id", input.ownerId);

    throw error;
  }
}
