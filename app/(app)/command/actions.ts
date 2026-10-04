"use server";

import { redirect } from "next/navigation";
import { estimateModelCost } from "@/lib/agents/openai";
import { planChiefOperatorCommand } from "@/lib/command/chief";
import { executeChiefActions } from "@/lib/command/executor";
import { createClient } from "@/lib/supabase/server";

function textValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function sendChiefCommand(formData: FormData) {
  const message = textValue(formData, "message");
  let threadId = textValue(formData, "threadId");

  if (message.length < 2) {
    redirect(threadId ? `/command?thread=${threadId}&error=Enter%20a%20command` : "/command?error=Enter%20a%20command");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (claimsError || !ownerId) redirect("/login");

  if (!threadId) {
    const { data: thread, error } = await supabase
      .from("command_threads")
      .insert({
        owner_id: ownerId,
        title: message.slice(0, 72),
      })
      .select("id")
      .single();

    if (error || !thread) {
      redirect(`/command?error=${encodeURIComponent(error?.message || "Could not create command thread")}`);
    }
    threadId = thread.id;
  }

  const { data: userMessage, error: userMessageError } = await supabase
    .from("command_messages")
    .insert({
      thread_id: threadId,
      owner_id: ownerId,
      role: "user",
      content: message,
    })
    .select("id")
    .single();

  if (userMessageError || !userMessage) {
    redirect(`/command?thread=${threadId}&error=${encodeURIComponent(userMessageError?.message || "Could not save message")}`);
  }

  const [
    { data: chief },
    { data: projects },
    { data: agents },
    { data: schedules },
    { data: recentMessages },
    { data: globalBrain },
  ] = await Promise.all([
    supabase
      .from("agent_definitions")
      .select("agent_key,name,default_model,instructions,status")
      .eq("agent_key", "chief_operator")
      .single(),
    supabase
      .from("projects")
      .select("id,name,domain,project_type,status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("agent_definitions")
      .select("agent_key,name,description,status,model_class")
      .in("status", ["testing", "active"])
      .order("sort_order"),
    supabase
      .from("scheduled_tasks")
      .select("id,title,project_id,target_agent_key,schedule_kind,schedule_config,timezone,status")
      .in("status", ["active", "paused", "running"])
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("command_messages")
      .select("role,content,created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(20),
    supabase
      .from("global_brain_entries")
      .select("category,title,content,priority")
      .eq("owner_id", ownerId)
      .eq("active", true)
      .order("priority", { ascending: false })
      .limit(30),
  ]);

  if (!chief || !["testing", "active"].includes(chief.status)) {
    redirect(`/command?thread=${threadId}&error=Chief%20Operator%20is%20not%20available`);
  }

  const workspaceContext = JSON.stringify(
    {
      projects: projects || [],
      installed_agents: agents || [],
      schedules: schedules || [],
      global_brain: globalBrain || [],
      allowed_internal_actions: [
        "create_project",
        "delegate_agent",
        "create_ga4_funnel",
        "schedule_agent_task",
        "manage_schedule",
        "request_report",
        "run_technical_audit",
        "run_prospect_audit",
        "link_github_repo",
        "run_serp_research",
      ],
      safety: {
        external_impact_requires_approval: true,
        do_not_invent_project_context: true,
      },
    },
    null,
    2,
  );

  try {
    const result = await planChiefOperatorCommand({
      model: process.env.OPENAI_ROUTINE_MODEL || chief.default_model || "gpt-6-luna",
      instructions: chief.instructions,
      userMessage: message,
      conversation: (recentMessages || [])
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({
          role: item.role as "user" | "assistant",
          content: item.content,
        })),
      workspaceContext,
    });

    const actionResults = result.plan.needs_clarification
      ? []
      : await executeChiefActions({
          ownerId,
          actions: result.plan.actions,
        });

    const actionSummary = actionResults.length
      ? "\n\n" +
        actionResults
          .map((action) => `• ${action.status === "completed" ? "Done" : action.status === "failed" ? "Failed" : "Skipped"}: ${action.summary}`)
          .join("\n")
      : "";

    const assistantText = result.plan.needs_clarification
      ? `${result.plan.reply}\n\n${result.plan.clarification_question || "I need one detail before I can continue."}`
      : `${result.plan.reply}${actionSummary}`;

    const model = process.env.OPENAI_ROUTINE_MODEL || chief.default_model || "gpt-6-luna";
    const cost = estimateModelCost(
      model,
      result.usage.inputTokens,
      result.usage.outputTokens,
    );

    const { data: assistantMessage, error: assistantError } = await supabase
      .from("command_messages")
      .insert({
        thread_id: threadId,
        owner_id: ownerId,
        role: "assistant",
        content: assistantText,
        metadata: {
          response_id: result.responseId,
          model,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          estimated_cost: cost,
          needs_clarification: result.plan.needs_clarification,
        },
      })
      .select("id")
      .single();

    if (assistantError || !assistantMessage) {
      throw new Error(assistantError?.message || "Could not save Chief Operator response.");
    }

    for (let index = 0; index < result.plan.actions.length; index += 1) {
      const action = result.plan.actions[index];
      const executed = actionResults[index];

      await supabase.from("command_actions").insert({
        thread_id: threadId,
        message_id: assistantMessage.id,
        owner_id: ownerId,
        action_type: action.type,
        status:
          executed?.status === "completed"
            ? "completed"
            : executed?.status === "failed"
              ? "failed"
              : "planned",
        project_id: executed?.projectId || null,
        target_agent_key: executed?.targetAgentKey || action.agent_key || null,
        arguments: action,
        result: executed || {},
        error: executed?.status === "failed" ? executed.summary : null,
        completed_at: executed ? new Date().toISOString() : null,
      });
    }

    await supabase
      .from("command_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", threadId);

    redirect(`/command?thread=${threadId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Chief Operator failed.";

    await supabase.from("command_messages").insert({
      thread_id: threadId,
      owner_id: ownerId,
      role: "assistant",
      content: `I could not complete that command. ${errorMessage}`,
      metadata: { error: true },
    });

    redirect(`/command?thread=${threadId}&error=${encodeURIComponent(errorMessage)}`);
  }
}

export async function newCommandThread() {
  redirect("/command");
}
