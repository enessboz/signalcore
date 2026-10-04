import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

type ApprovalPayload = {
  title?: string;
  summary?: string;
  target?: string | null;
  instructions?: string;
  agent_key?: string;
  agent_run_id?: string;
  [key: string]: unknown;
};

export type ExecutorCapability = {
  actionType: string;
  supported: boolean;
  configured: boolean;
  executable: boolean;
  label: string;
  reason: string;
};

function normalizeUuidTarget(value: string | null | undefined) {
  if (!value) return null;
  const match = value.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
  return match?.[0] || null;
}

export function getExecutorCapability(
  actionType: string,
  payload: ApprovalPayload,
): ExecutorCapability {
  if (actionType === "approve_output") {
    const targetId = normalizeUuidTarget(
      typeof payload.target === "string" ? payload.target : null,
    );
    return {
      actionType,
      supported: true,
      configured: true,
      executable: Boolean(targetId),
      label: "SignalCore Output Executor",
      reason: targetId
        ? "Ready to mark the referenced SignalCore output as approved."
        : "The approval payload does not contain a valid output UUID target.",
    };
  }

  if (actionType === "github_write") {
    const configured = Boolean(process.env.GITHUB_TOKEN);
    return {
      actionType,
      supported: false,
      configured,
      executable: false,
      label: "GitHub Write Executor",
      reason: configured
        ? "GitHub credential exists, but the current approval payload lacks a structured repository/path/content execution contract."
        : "GITHUB_TOKEN is not configured and the structured GitHub execution contract is not enabled yet.",
    };
  }

  if (actionType === "cms_write" || actionType === "publish") {
    return {
      actionType,
      supported: false,
      configured: false,
      executable: false,
      label: "CMS Executor",
      reason:
        "No project-scoped CMS write adapter is registered yet. Approval remains recorded but cannot execute.",
    };
  }

  if (actionType === "deploy") {
    return {
      actionType,
      supported: false,
      configured: false,
      executable: false,
      label: "Deployment Executor",
      reason:
        "Deployment execution requires a structured project deployment adapter and target-specific validation.",
    };
  }

  if (actionType === "send_outreach") {
    return {
      actionType,
      supported: false,
      configured: false,
      executable: false,
      label: "Outreach Executor",
      reason:
        "Automated outreach sending is disabled until a mail provider, deliverability policy and compliance controls are configured.",
    };
  }

  if (actionType === "delete") {
    return {
      actionType,
      supported: false,
      configured: false,
      executable: false,
      label: "Destructive Action Executor",
      reason:
        "Generic delete execution is intentionally unsupported. Destructive actions require a resource-specific adapter.",
    };
  }

  return {
    actionType,
    supported: false,
    configured: false,
    executable: false,
    label: "External Action Executor",
    reason:
      "No registered executor can safely perform this action from the current structured payload.",
  };
}

export async function executeApprovedAction(input: {
  ownerId: string;
  approvalId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: approval, error } = await supabase
    .from("approvals")
    .select("id,project_id,owner_id,action_type,status,payload,risk_level,execution_status")
    .eq("id", input.approvalId)
    .eq("owner_id", input.ownerId)
    .single();

  if (error || !approval) {
    throw new Error(error?.message || "Approval not found.");
  }

  if (approval.status !== "approved" || approval.execution_status !== "ready") {
    throw new Error("Only approved actions in ready state can execute.");
  }

  const payload = (approval.payload || {}) as ApprovalPayload;
  const capability = getExecutorCapability(approval.action_type, payload);
  if (!capability.executable) {
    throw new Error(capability.reason);
  }

  const { error: runningError } = await supabase
    .from("approvals")
    .update({
      execution_status: "running",
      execution_result: {
        executor: capability.label,
        started_at: new Date().toISOString(),
      },
    })
    .eq("id", approval.id)
    .eq("owner_id", input.ownerId)
    .eq("execution_status", "ready");

  if (runningError) throw new Error(runningError.message);

  try {
    let result: Record<string, unknown> = {};

    if (approval.action_type === "approve_output") {
      const outputId = normalizeUuidTarget(
        typeof payload.target === "string" ? payload.target : null,
      );
      if (!outputId) throw new Error("Output target is invalid.");

      const { data: output, error: outputError } = await supabase
        .from("generated_outputs")
        .update({ status: "approved" })
        .eq("id", outputId)
        .eq("project_id", approval.project_id)
        .eq("owner_id", input.ownerId)
        .select("id,title,status,output_type")
        .single();

      if (outputError || !output) {
        throw new Error(outputError?.message || "Output could not be approved.");
      }

      result = {
        output_id: output.id,
        title: output.title,
        output_type: output.output_type,
        status: output.status,
      };
    } else {
      throw new Error("Executor registry changed while action was running.");
    }

    const executionResult = {
      executor: capability.label,
      completed_at: new Date().toISOString(),
      result,
    };

    const { error: completeError } = await supabase
      .from("approvals")
      .update({
        execution_status: "succeeded",
        execution_result: executionResult,
      })
      .eq("id", approval.id)
      .eq("owner_id", input.ownerId);

    if (completeError) throw new Error(completeError.message);

    await supabase.from("audit_events").insert({
      project_id: approval.project_id,
      owner_id: input.ownerId,
      actor_type: "system",
      event_type: "approval_executed",
      entity_type: "approval",
      entity_id: approval.id,
      metadata: {
        action_type: approval.action_type,
        risk_level: approval.risk_level,
        executor: capability.label,
        result,
      },
    });

    return { capability, result };
  } catch (executionError) {
    const message =
      executionError instanceof Error
        ? executionError.message
        : "Approval execution failed.";

    await supabase
      .from("approvals")
      .update({
        execution_status: "failed",
        execution_result: {
          executor: capability.label,
          failed_at: new Date().toISOString(),
          error: message,
        },
      })
      .eq("id", approval.id)
      .eq("owner_id", input.ownerId);

    throw executionError;
  }
}
