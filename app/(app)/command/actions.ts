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
    { data: outputProfiles },
    { data: budgetLimits },
    { data: salesCampaigns },
    { data: salesLeads },
    { data: technicalSchedules },
    { data: rankSettings },
    { data: trackedKeywords },
    { data: opportunitySettings },
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
    supabase
      .from("output_profiles")
      .select("profile_key,name,output_type,strict_mode,is_default,active")
      .eq("owner_id", ownerId)
      .eq("active", true)
      .order("output_type")
      .order("is_default", { ascending: false }),
    supabase
      .from("budget_limits")
      .select("project_id,category,monthly_limit,soft_warning_percent,hard_stop")
      .eq("owner_id", ownerId),
    supabase
      .from("sales_campaigns")
      .select("id,name,status,country,industry,location_code,language_code,min_score,max_candidates,max_run_cost_usd,auto_discovery_enabled,schedule_kind,schedule_config,timezone,auto_qualify_count,last_auto_run_at,last_auto_status")
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .limit(50),
    supabase
      .from("sales_leads")
      .select("id,domain,company_name,country,industry,stage,qualification_status,score,converted_project_id,updated_at")
      .order("updated_at", { ascending: false })
      .limit(120),
    supabase
      .from("technical_crawl_schedules")
      .select("id,project_id,name,crawl_type,max_urls,schedule_kind,schedule_config,timezone,status,last_run_at,last_status,last_error")
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(80),
    supabase
      .from("rank_tracking_settings")
      .select("project_id,active,auto_discover_enabled,auto_findings_enabled,max_auto_keywords,min_impressions_28d,position_min,position_max,default_location_code,default_language_code,default_device,daily_high_priority_limit,last_seeded_at,last_worker_run_at")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase
      .from("tracked_keywords")
      .select("id,project_id,keyword,source,priority,cadence,depth,location_code,language_code,device,active,last_position,last_ranking_url,last_checked_at,last_status")
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(250),
    supabase
      .from("opportunity_scan_settings")
      .select("project_id,enabled,scan_gsc,scan_ga4,scan_rank,cadence,last_run_at,last_data_date,last_status,last_error")
      .order("updated_at", { ascending: false })
      .limit(100),
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
      output_profiles: outputProfiles || [],
      budget_limits: budgetLimits || [],
      sales_campaigns: salesCampaigns || [],
      sales_leads: salesLeads || [],
      technical_crawl_schedules: technicalSchedules || [],
      rank_tracking_settings: rankSettings || [],
      tracked_keywords: trackedKeywords || [],
      opportunity_engine_settings: opportunitySettings || [],
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
        "set_google_auto_sync",
        "queue_google_backfill",
        "add_global_brain_entry",
        "add_project_background",
        "assign_output_profile",
        "set_budget_limit",
        "convert_project_to_client",
        "create_technical_crawl_schedule",
        "manage_technical_crawl_schedule",
        "configure_rank_tracking",
        "add_tracked_keywords",
        "seed_rank_from_gsc",
        "run_rank_tracking",
        "configure_opportunity_engine",
        "run_opportunity_scan",
        "create_sales_campaign",
        "run_sales_campaign",
        "qualify_sales_campaign",
        "configure_sales_automation",
        "convert_sales_lead",
        "audit_sales_lead",
        "create_sales_deck",
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
