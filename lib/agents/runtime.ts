import { buildAgentProjectContext, contextToPrompt } from "@/lib/agents/context";
import {
  estimateModelCost,
  routeAgentTask,
  runStructuredAgent,
} from "@/lib/agents/openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

type AgentDefinition = {
  agent_key: string;
  name: string;
  description: string;
  model_class: string;
  default_model: string | null;
  status: "planned" | "testing" | "active" | "disabled";
  instructions: string;
};

function configuredModel(definition: AgentDefinition) {
  if (definition.model_class === "reasoning") {
    return process.env.OPENAI_REASONING_MODEL || definition.default_model || "gpt-6-sol";
  }
  if (definition.model_class === "coding") {
    return process.env.OPENAI_CODING_MODEL || definition.default_model || "gpt-6-sol";
  }
  return process.env.OPENAI_ROUTINE_MODEL || definition.default_model || "gpt-6-luna";
}

async function createRun(input: {
  ownerId: string;
  projectId: string;
  agentKey: string;
  parentRunId?: string | null;
  triggerType?: "manual" | "scheduled" | "handoff" | "condition";
  taskType?: string;
  userRequest: string;
  model?: string | null;
  contextManifest?: Record<string, unknown>;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const { data, error } = await supabase
    .from("agent_runs")
    .insert({
      owner_id: input.ownerId,
      project_id: input.projectId,
      agent_key: input.agentKey,
      parent_run_id: input.parentRunId || null,
      trigger_type: input.triggerType || "manual",
      task_type: input.taskType || "analysis",
      user_request: input.userRequest,
      status: "running",
      model: input.model || null,
      context_manifest: input.contextManifest || {},
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Agent run could not be created.");
  }
  return data.id as string;
}

async function finishRun(input: {
  runId: string;
  output: Record<string, unknown>;
  responseId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const cost = estimateModelCost(input.model, input.inputTokens, input.outputTokens);

  const { error } = await supabase
    .from("agent_runs")
    .update({
      status: "succeeded",
      output: input.output,
      response_id: input.responseId,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      actual_cost: cost,
      completed_at: new Date().toISOString(),
    })
    .eq("id", input.runId);

  if (error) throw new Error(error.message);
}

async function failRun(runId: string, error: unknown, client?: SupabaseClient) {
  const supabase = client || (await createClient());
  await supabase
    .from("agent_runs")
    .update({
      status: "failed",
      error: error instanceof Error ? error.message : "Agent run failed.",
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

export async function executeAgentTask(input: {
  ownerId: string;
  projectId: string;
  selectedAgentKey: string;
  userRequest: string;
  triggerType?: "manual" | "scheduled" | "handoff" | "condition";
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const context = await buildAgentProjectContext(input.projectId, supabase);
  const projectPrompt = contextToPrompt(context);

  const { data: definitions, error } = await supabase
    .from("agent_definitions")
    .select("agent_key,name,description,model_class,default_model,status,instructions")
    .in("status", ["testing", "active"]);

  if (error || !definitions?.length) {
    throw new Error(error?.message || "No active agent definitions are available.");
  }

  const byKey = new Map(definitions.map((definition) => [definition.agent_key, definition as AgentDefinition]));
  const contextManifest = {
    ...context.manifest,
    project_type: context.project.project_type,
  };

  let targetKey = input.selectedAgentKey;
  let parentRunId: string | null = null;

  if (targetKey === "auto") {
    const router = byKey.get("router_orchestrator");
    if (!router) throw new Error("Router / Orchestrator is not available.");

    const routerModel = configuredModel(router);
    const routerRunId = await createRun({
      ownerId: input.ownerId,
      projectId: input.projectId,
      agentKey: router.agent_key,
      userRequest: input.userRequest,
      model: routerModel,
      taskType: "routing",
      contextManifest,
      triggerType: input.triggerType || "manual",
      client: supabase,
    });

    try {
      const specialists = definitions
        .filter((definition) =>
          !["router_orchestrator", "chief_operator"].includes(definition.agent_key),
        )
        .map((definition) => ({
          agent_key: definition.agent_key,
          name: definition.name,
          description: definition.description,
        }));

      const routed = await routeAgentTask({
        model: routerModel,
        instructions: router.instructions,
        request: input.userRequest,
        projectContext: projectPrompt,
        availableAgents: specialists,
      });

      targetKey = specialists.some((agent) => agent.agent_key === routed.output.selected_agent)
        ? routed.output.selected_agent
        : "seo_lead";

      await finishRun({
        runId: routerRunId,
        output: routed.output as unknown as Record<string, unknown>,
        responseId: routed.responseId,
        model: routerModel,
        inputTokens: routed.usage.inputTokens,
        outputTokens: routed.usage.outputTokens,
        client: supabase,
      });
      parentRunId = routerRunId;
    } catch (routeError) {
      await failRun(routerRunId, routeError, supabase);
      throw routeError;
    }
  }

  const target = byKey.get(targetKey);
  if (!target || ["router_orchestrator", "chief_operator"].includes(target.agent_key)) {
    throw new Error("Selected specialist agent is not available.");
  }

  const model = configuredModel(target);
  const runId = await createRun({
    ownerId: input.ownerId,
    projectId: input.projectId,
    agentKey: target.agent_key,
    parentRunId,
    triggerType: parentRunId ? "handoff" : input.triggerType || "manual",
    userRequest: input.userRequest,
    model,
    contextManifest,
    client: supabase,
  });

  try {
    const result = await runStructuredAgent({
      model,
      instructions: target.instructions,
      request: input.userRequest,
      projectContext: projectPrompt,
    });

    await finishRun({
      runId,
      output: result.output as unknown as Record<string, unknown>,
      responseId: result.responseId,
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      client: supabase,
    });

    if (result.output.handoff.needed && result.output.handoff.to_agent_key) {
      await supabase.from("agent_handoffs").insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        from_run_id: runId,
        to_agent_key: result.output.handoff.to_agent_key,
        reason: result.output.handoff.reason || "Specialist requested handoff.",
        status: "proposed",
      });
    }

    return runId;
  } catch (agentError) {
    await failRun(runId, agentError, supabase);
    throw agentError;
  }
}
