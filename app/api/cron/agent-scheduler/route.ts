import { NextRequest, NextResponse } from "next/server";
import { executeAgentTask } from "@/lib/agents/runtime";
import { isScheduleDue } from "@/lib/command/schedule";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.SUPABASE_SECRET_KEY) {
    return NextResponse.json(
      { error: "SUPABASE_SECRET_KEY is not configured." },
      { status: 503 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const supabase = createAdminClient();
  const { data: tasks, error } = await supabase
    .from("scheduled_tasks")
    .select("id,owner_id,project_id,title,instruction,target_agent_key,schedule_kind,schedule_config,timezone,status,last_run_at,failure_count")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = new Date();
  const due = (tasks || []).filter((task) =>
    isScheduleDue({
      scheduleKind: task.schedule_kind,
      scheduleConfig: task.schedule_config || {},
      timezone: task.timezone || "Europe/Istanbul",
      lastRunAt: task.last_run_at,
      now,
    }),
  );

  const results: Array<Record<string, unknown>> = [];

  for (const task of due.slice(0, 12)) {
    if (!task.project_id) {
      await supabase
        .from("scheduled_tasks")
        .update({
          status: "failed",
          last_error: "Scheduled agent task has no project.",
          failure_count: Number(task.failure_count || 0) + 1,
          updated_at: now.toISOString(),
        })
        .eq("id", task.id);

      results.push({
        id: task.id,
        status: "failed",
        error: "No project configured.",
      });
      continue;
    }

    await supabase
      .from("scheduled_tasks")
      .update({
        status: "running",
        updated_at: now.toISOString(),
      })
      .eq("id", task.id);

    try {
      const runId = await executeAgentTask({
        ownerId: task.owner_id,
        projectId: task.project_id,
        selectedAgentKey:
          task.target_agent_key === "router_orchestrator"
            ? "auto"
            : task.target_agent_key,
        userRequest: task.instruction,
        triggerType: "scheduled",
        client: supabase,
      });

      const nextStatus = task.schedule_kind === "once" ? "completed" : "active";

      await supabase
        .from("scheduled_tasks")
        .update({
          status: nextStatus,
          last_run_at: new Date().toISOString(),
          last_run_id: runId,
          failure_count: 0,
          last_error: null,
          next_run_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id);

      results.push({
        id: task.id,
        title: task.title,
        status: "succeeded",
        run_id: runId,
      });
    } catch (runError) {
      const failureCount = Number(task.failure_count || 0) + 1;
      const message =
        runError instanceof Error ? runError.message : "Scheduled agent run failed.";

      await supabase
        .from("scheduled_tasks")
        .update({
          status: failureCount >= 3 ? "failed" : "active",
          failure_count: failureCount,
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id);

      results.push({
        id: task.id,
        title: task.title,
        status: "failed",
        error: message,
      });
    }
  }

  return NextResponse.json({
    checked: tasks?.length || 0,
    due: due.length,
    processed: results.length,
    results,
    time: now.toISOString(),
  });
}
