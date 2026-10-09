import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChiefPlan } from "@/lib/command/chief";
import {
  executeChiefActions,
  type CommandActionResult,
} from "@/lib/command/executor";

type PlanStatus =
  | "planned"
  | "running"
  | "waiting_data"
  | "waiting_user"
  | "blocked_tool"
  | "completed"
  | "failed"
  | "cancelled";

function humanizeAction(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function classifyFailure(message: string): {
  status: "waiting_user" | "blocked_tool" | "failed";
  blockerType: string;
} {
  const lower = message.toLowerCase();

  if (
    /not configured|credentials|api key|permission|forbidden|environment variable|provider.*missing|connection.*required/.test(
      lower,
    )
  ) {
    return { status: "blocked_tool", blockerType: "tool_configuration" };
  }

  if (
    /could not.*resolve|could not be uniquely resolved|requires an explicit|is required|must provide|select a|choose a|missing project/.test(
      lower,
    )
  ) {
    return { status: "waiting_user", blockerType: "user_input" };
  }

  return { status: "failed", blockerType: "execution_error" };
}

function planStatusForResult(result: CommandActionResult): PlanStatus {
  if (result.status === "waiting_data") return "waiting_data";
  if (result.status === "waiting_user") return "waiting_user";
  if (result.status === "blocked_tool") return "blocked_tool";
  if (result.status === "failed") return classifyFailure(result.summary).status;
  return "running";
}

export async function createAndExecuteCommandPlan(input: {
  client: SupabaseClient;
  ownerId: string;
  threadId: string;
  sourceMessageId: string;
  objective: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  actions: ChiefPlan["actions"];
  continuationOf?: string | null;
}) {
  const executable = input.actions.filter((action) => action.type !== "no_action");
  if (!executable.length) {
    return {
      planId: null,
      status: "completed" as const,
      results: [] as CommandActionResult[],
    };
  }

  const title =
    executable[0]?.step_title?.trim() ||
    input.objective.trim().slice(0, 96) ||
    "SignalCore work plan";

  const { data: plan, error: planError } = await input.client
    .from("command_plans")
    .insert({
      thread_id: input.threadId,
      source_message_id: input.sourceMessageId,
      owner_id: input.ownerId,
      title,
      objective: input.objective,
      status: "planned",
      current_step: 0,
      total_steps: executable.length,
      continuation_of: input.continuationOf || null,
      planner_model: input.model,
      planner_usage: {
        input_tokens: input.usage.inputTokens,
        output_tokens: input.usage.outputTokens,
      },
      context: {
        action_types: executable.map((action) => action.type),
      },
    })
    .select("id")
    .single();

  if (planError || !plan) {
    throw new Error(planError?.message || "Command work plan could not be created.");
  }

  const stepRows = executable.map((action, index) => ({
    plan_id: plan.id,
    owner_id: input.ownerId,
    sequence: index + 1,
    title:
      action.step_title?.trim() ||
      humanizeAction(action.type),
    action_type: action.type,
    status: "pending",
    arguments: action,
  }));

  const { data: steps, error: stepsError } = await input.client
    .from("command_plan_steps")
    .insert(stepRows)
    .select("id,sequence,title,status")
    .order("sequence");

  if (stepsError || !steps?.length) {
    await input.client
      .from("command_plans")
      .update({
        status: "failed",
        last_error: stepsError?.message || "Plan steps could not be created.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.id);
    throw new Error(stepsError?.message || "Command plan steps could not be created.");
  }

  await input.client
    .from("command_plans")
    .update({
      status: "running",
      updated_at: new Date().toISOString(),
    })
    .eq("id", plan.id);

  const results: CommandActionResult[] = [];
  let finalStatus: PlanStatus = "completed";

  for (let index = 0; index < executable.length; index += 1) {
    const action = executable[index]!;
    const step = steps[index]!;
    const startedAt = new Date().toISOString();

    await input.client
      .from("command_plans")
      .update({
        status: "running",
        current_step: index + 1,
        updated_at: startedAt,
      })
      .eq("id", plan.id);

    await input.client
      .from("command_plan_steps")
      .update({
        status: "running",
        attempt_count: 1,
        started_at: startedAt,
        blocker_type: null,
        blocker_message: null,
        updated_at: startedAt,
      })
      .eq("id", step.id)
      .eq("owner_id", input.ownerId);

    const [result] = await executeChiefActions({
      ownerId: input.ownerId,
      actions: [action],
      stopOnFailure: true,
    });

    const actual =
      result ||
      ({
        type: action.type,
        status: "failed",
        summary: "Action did not return an execution result.",
      } as CommandActionResult);
    results.push(actual);

    if (actual.status === "completed" || actual.status === "skipped") {
      await input.client
        .from("command_plan_steps")
        .update({
          status: actual.status,
          result: actual,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", step.id)
        .eq("owner_id", input.ownerId);
      continue;
    }

    finalStatus = planStatusForResult(actual);
    const classified =
      actual.status === "failed"
        ? classifyFailure(actual.summary)
        : {
            status: finalStatus === "waiting_user" ? "waiting_user" : finalStatus,
            blockerType:
              finalStatus === "waiting_data"
                ? "data_dependency"
                : finalStatus === "blocked_tool"
                  ? "tool_configuration"
                  : "execution_error",
          };

    await input.client
      .from("command_plan_steps")
      .update({
        status: classified.status,
        result: actual,
        blocker_type: classified.blockerType,
        blocker_message: actual.summary,
        required_input:
          classified.status === "waiting_user"
            ? { requested: actual.summary }
            : {},
        completed_at:
          classified.status === "failed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", step.id)
      .eq("owner_id", input.ownerId);

    await input.client
      .from("command_plans")
      .update({
        status: classified.status,
        current_step: index + 1,
        last_error: actual.summary,
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.id)
      .eq("owner_id", input.ownerId);

    break;
  }

  if (finalStatus === "completed") {
    await input.client
      .from("command_plans")
      .update({
        status: "completed",
        current_step: executable.length,
        last_error: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.id)
      .eq("owner_id", input.ownerId);
  }

  return {
    planId: plan.id as string,
    status: finalStatus,
    results,
  };
}
