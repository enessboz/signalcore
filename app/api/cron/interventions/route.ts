import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { evaluateInterventionCheck } from "@/lib/interventions/evaluate";
import { finishRuntimeWorkerRun, startRuntimeWorkerRun, summarizeWorkerStatus } from "@/lib/runtime/worker-runs";

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

  const supabase = createAdminClient();
  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:interventions",
    ttlSeconds: 360,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another intervention monitor invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  const { data: checks, error } = await supabase
    .from("seo_intervention_checks")
    .select("id,project_id,owner_id,intervention_id,checkpoint_days,due_date")
    .eq("status", "pending")
    .lte("due_date", today)
    .order("due_date", { ascending: true })
    .limit(30);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "interventions",
    ownerIds: (checks || []).map((item) => item.owner_id),
    metadata: { due_checks: checks?.length || 0 },
  });

  const results: Array<Record<string, unknown>> = [];

  for (const check of checks || []) {
    try {
      const result = await evaluateInterventionCheck({
        checkId: check.id,
        client: supabase,
      });
      results.push({
        id: check.id,
        project_id: check.project_id,
        checkpoint_days: check.checkpoint_days,
        ...result,
      });
    } catch (evaluationError) {
      const message =
        evaluationError instanceof Error
          ? evaluationError.message
          : "Intervention evaluation failed.";

      await supabase
        .from("seo_intervention_checks")
        .update({
          last_attempt_at: new Date().toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", check.id);

      results.push({
        id: check.id,
        project_id: check.project_id,
        checkpoint_days: check.checkpoint_days,
        status: "failed_attempt",
        error: message,
      });
    }
  }

  const failedCount = results.filter((item) => item.status === "failed_attempt").length;
  const waitingCount = results.filter((item) => item.status === "pending").length;

  await finishRuntimeWorkerRun({
    client: supabase,
    tracker: runtimeRun,
    status: summarizeWorkerStatus({
      processed: Math.max(results.length, 1),
      failed: failedCount,
      partial: waitingCount,
    }),
    metrics: {
      due_checks: checks?.length || 0,
      evaluated: results.filter((item) => item.status === "evaluated").length,
      still_waiting: waitingCount,
      failed_attempts: failedCount,
    },
  });

  return NextResponse.json({
    due_checks: checks?.length || 0,
    evaluated: results.filter((item) => item.status === "evaluated").length,
    still_waiting: results.filter((item) => item.status === "pending").length,
    results,
    time: new Date().toISOString(),
  });
}

// Vercel Cron invokes production cron routes with GET.
export async function GET(request: NextRequest) {
  return POST(request);
}
