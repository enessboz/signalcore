import { NextRequest, NextResponse } from "next/server";
import { processQueuedCrawlBatch } from "@/lib/crawl/distributed";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import {
  finishRuntimeWorkerRun,
  startRuntimeWorkerRun,
  summarizeWorkerStatus,
} from "@/lib/runtime/worker-runs";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (!expected || auth !== "Bearer " + expected) {
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
    key: "cron:crawl-worker",
    ttlSeconds: 300,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another crawl worker invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const { data: runs, error } = await supabase
    .from("crawl_runs")
    .select("id,owner_id,project_id,created_at")
    .eq("execution_mode", "queue")
    .eq("status", "running")
    .order("last_worker_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(3);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const target = runs?.[0] || null;
  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "crawl-worker",
    ownerIds: target ? [target.owner_id] : [],
    metadata: {
      running_queue_crawls: runs?.length || 0,
      selected_run_id: target?.id || null,
    },
  });

  if (!target) {
    await supabase
      .from("crawl_runs")
      .update({ last_worker_at: new Date().toISOString() })
      .eq("id", target.id)
      .eq("owner_id", target.owner_id);

    await finishRuntimeWorkerRun({
      client: supabase,
      tracker: runtimeRun,
      status: "succeeded",
      metrics: { running_queue_crawls: 0, processed: 0 },
    });

    return NextResponse.json({
      status: "idle",
      running_queue_crawls: 0,
      time: new Date().toISOString(),
    });
  }

  try {
    const startedAt = Date.now();
    const deadlineAt = startedAt + 235_000;
    const totals = {
      batches: 0,
      processed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      newUrls: 0,
      queuedRemaining: 0,
      claimedRemaining: 0,
      complete: false,
    };
    let finalSummary: Record<string, unknown> | null = null;

    while (Date.now() + 25_000 < deadlineAt && !totals.complete) {
      const result = await processQueuedCrawlBatch({
        client: supabase,
        runId: target.id,
        deadlineAt,
      });

      totals.batches += 1;
      totals.processed += result.processed;
      totals.succeeded += result.succeeded;
      totals.retried += result.retried;
      totals.failed += result.failed;
      totals.skipped += result.skipped;
      totals.newUrls += result.newUrls;
      totals.queuedRemaining = result.queuedRemaining;
      totals.claimedRemaining = result.claimedRemaining;
      totals.complete = result.complete;
      finalSummary = result.finalSummary;

      if (
        result.complete ||
        (result.processed === 0 &&
          result.queuedRemaining === 0 &&
          result.claimedRemaining === 0)
      ) {
        break;
      }

      if (result.processed === 0 && result.queuedRemaining > 0) {
        // Remaining URLs may be waiting for retry backoff. Avoid hot-looping.
        break;
      }
    }

    if (totals.complete) {
      const { data: completedRun } = await supabase
        .from("crawl_runs")
        .select("status")
        .eq("id", target.id)
        .maybeSingle();

      await supabase
        .from("technical_crawl_schedules")
        .update({
          status: "active",
          last_status:
            completedRun?.status === "partial" ? "partial" : "succeeded",
          last_error: null,
          failure_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("last_crawl_run_id", target.id)
        .eq("owner_id", target.owner_id);
    }

    await finishRuntimeWorkerRun({
      client: supabase,
      tracker: runtimeRun,
      status: summarizeWorkerStatus({
        processed: Math.max(totals.processed, 1),
        failed: totals.failed,
        partial: totals.retried,
      }),
      metrics: {
        run_id: target.id,
        batches: totals.batches,
        processed: totals.processed,
        succeeded: totals.succeeded,
        retried: totals.retried,
        failed: totals.failed,
        skipped: totals.skipped,
        new_urls: totals.newUrls,
        queued_remaining: totals.queuedRemaining,
        claimed_remaining: totals.claimedRemaining,
        complete: totals.complete,
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return NextResponse.json({
      status: totals.complete ? "completed" : "running",
      runId: target.id,
      ...totals,
      finalSummary,
      elapsed_ms: Date.now() - startedAt,
      time: new Date().toISOString(),
    });
  } catch (runError) {
    const message =
      runError instanceof Error ? runError.message : "Crawl worker failed.";

    await finishRuntimeWorkerRun({
      client: supabase,
      tracker: runtimeRun,
      status: "failed",
      metrics: {
        run_id: target.id,
        processed: 0,
      },
      error: message,
    });

    return NextResponse.json(
      {
        status: "failed",
        run_id: target.id,
        error: message,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
