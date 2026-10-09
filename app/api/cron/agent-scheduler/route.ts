import { NextRequest, NextResponse } from "next/server";
import { executeAgentTask } from "@/lib/agents/runtime";
import { isScheduleDue, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { recoverStaleScheduledTasks } from "@/lib/runtime/recovery";
import { createReportingOutput, type OutputFormat } from "@/lib/outputs/reporting";
import { finishRuntimeWorkerRun, startRuntimeWorkerRun, summarizeWorkerStatus } from "@/lib/runtime/worker-runs";
import { resumeReadyCommandPlans } from "@/lib/command/plan-engine";

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

  const openAiReady = Boolean(process.env.OPENAI_API_KEY);

  const supabase = createAdminClient();
  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:agent-scheduler",
    ttlSeconds: 360,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another agent scheduler invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const recoveredStaleTasks = await recoverStaleScheduledTasks(supabase);
  const resumedPlans = await resumeReadyCommandPlans({
    client: supabase,
    maxPlans: 5,
  });

  const { data: tasks, error } = await supabase
    .from("scheduled_tasks")
    .select("id,owner_id,project_id,title,instruction,target_agent_key,schedule_kind,schedule_config,post_run_config,timezone,status,last_run_at,failure_count")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "agent-scheduler",
    ownerIds: (tasks || []).map((item) => item.owner_id),
    metadata: {
      tasks_checked: tasks?.length || 0,
      ready_plans_resumed: resumedPlans.length,
      openai_ready: openAiReady,
    },
  });

  const now = new Date();
  const due = openAiReady
    ? (tasks || []).filter((task) =>
        isScheduleDue({
      scheduleKind: task.schedule_kind as ScheduleKind,
      scheduleConfig: (task.schedule_config || {}) as ScheduleConfig,
      timezone: task.timezone || "Europe/Istanbul",
      lastRunAt: task.last_run_at,
          now,
        }),
      )
    : [];

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

      const postRun = (task.post_run_config || {}) as {
        report_on_importance?: boolean;
        minimum_importance?: "critical" | "high" | "medium" | "low";
        report_format?: OutputFormat;
      };

      let generatedOutput: { outputId: string; title: string } | null = null;

      if (postRun.report_on_importance) {
        const { data: completedRun } = await supabase
          .from("agent_runs")
          .select("output")
          .eq("id", runId)
          .maybeSingle();

        const runOutput = (completedRun?.output || {}) as {
          importance?: "critical" | "high" | "medium" | "low";
        };

        const rank = { low: 1, medium: 2, high: 3, critical: 4 };
        const currentImportance = runOutput.importance || "low";
        const threshold = postRun.minimum_importance || "high";

        if (rank[currentImportance] >= rank[threshold]) {
          const report = await createReportingOutput({
            ownerId: task.owner_id,
            projectId: task.project_id,
            format: postRun.report_format || "summary",
            instruction:
              `A scheduled analysis found ${currentImportance}-importance evidence. Prepare the requested follow-up output from the current approved findings and evidence. Scheduled task: ${task.title}. Original instruction: ${task.instruction}`,
            triggerType: "scheduled",
            client: supabase,
          });
          generatedOutput = {
            outputId: report.outputId,
            title: report.title,
          };
        }
      }

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
        generated_output: generatedOutput,
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

  const failedCount = results.filter((item) => item.status === "failed").length;

  await finishRuntimeWorkerRun({
    client: supabase,
    tracker: runtimeRun,
    status: summarizeWorkerStatus({
      processed: Math.max(results.length, 1),
      failed: failedCount,
    }),
    metrics: {
      recovered_stale_tasks: recoveredStaleTasks,
      ready_plans_resumed: resumedPlans.length,
      plans_completed: resumedPlans.filter((item) => item.status === "completed").length,
      plans_blocked: resumedPlans.filter((item) =>
        ["waiting_data", "waiting_user", "blocked_tool", "failed"].includes(
          String(item.status),
        ),
      ).length,
      openai_ready: openAiReady,
      checked: tasks?.length || 0,
      due: due.length,
      processed: results.length,
      failed: failedCount,
      outputs_generated: results.filter((item) => Boolean(item.generated_output)).length,
    },
  });

  return NextResponse.json({
    recovered_stale_tasks: recoveredStaleTasks,
    resumed_plans: resumedPlans,
    openai_ready: openAiReady,
    checked: tasks?.length || 0,
    due: due.length,
    processed: results.length,
    results,
    time: now.toISOString(),
  });
}

// Vercel Cron invokes production cron routes with GET.
export async function GET(request: NextRequest) {
  return POST(request);
}
