import { NextRequest, NextResponse } from "next/server";
import {
  isScheduleDue,
  type ScheduleConfig,
  type ScheduleKind,
} from "@/lib/command/schedule";
import {
  processQueuedCrawlBatch,
  startQueuedCrawl,
} from "@/lib/crawl/distributed";
import { processPerformanceQueue } from "@/lib/crawl/pagespeed";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { recoverStaleCrawlSchedules } from "@/lib/runtime/recovery";
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
  const invocationStartedAt = Date.now();
  const deadlineAt = invocationStartedAt + 235_000;

  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:technical-crawler",
    ttlSeconds: 360,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another technical crawler invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const recoveredStaleSchedules = await recoverStaleCrawlSchedules(supabase);
  const now = new Date();

  const [
    { data: schedules, error: scheduleError },
    { data: runningCrawls, error: crawlQueryError },
  ] = await Promise.all([
    supabase
      .from("technical_crawl_schedules")
      .select(
        "id,owner_id,project_id,name,crawl_type,max_urls,schedule_kind,schedule_config,timezone,status,last_run_at,last_status,last_error,failure_count,rotation_enabled,sitemap_offset,batch_size,min_delay_ms,respect_robots,js_render_mode,pagespeed_enabled,pagespeed_sample_size",
      )
      .eq("status", "active")
      .order("updated_at", { ascending: true })
      .limit(100),
    supabase
      .from("crawl_runs")
      .select("id,owner_id,project_id,last_worker_at,created_at")
      .eq("execution_mode", "queue")
      .eq("status", "running")
      .order("last_worker_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(2),
  ]);

  if (scheduleError) {
    return NextResponse.json({ error: scheduleError.message }, { status: 500 });
  }
  if (crawlQueryError) {
    return NextResponse.json({ error: crawlQueryError.message }, { status: 500 });
  }

  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "technical-crawler",
    ownerIds: [
      ...(schedules || []).map((item) => item.owner_id),
      ...(runningCrawls || []).map((item) => item.owner_id),
    ],
    metadata: {
      schedules_checked: schedules?.length || 0,
      running_queue_crawls: runningCrawls?.length || 0,
      orchestrates_frontier_worker: true,
      orchestrates_pagespeed_worker: true,
    },
  });

  const due = (schedules || [])
    .filter((schedule) =>
      isScheduleDue({
        scheduleKind: schedule.schedule_kind as ScheduleKind,
        scheduleConfig: (schedule.schedule_config || {}) as ScheduleConfig,
        timezone: schedule.timezone || "Europe/Istanbul",
        lastRunAt: schedule.last_run_at,
        now,
      }),
    )
    .slice(0, 3);

  const scheduleResults: Array<Record<string, unknown>> = [];

  for (const schedule of due) {
    if (Date.now() + 30_000 >= deadlineAt) break;

    await supabase
      .from("technical_crawl_schedules")
      .update({
        status: "running",
        last_status: "running",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", schedule.id)
      .eq("owner_id", schedule.owner_id);

    try {
      const queued = await startQueuedCrawl({
        client: supabase,
        ownerId: schedule.owner_id,
        projectId: schedule.project_id,
        maxUrls: schedule.max_urls,
        crawlType: schedule.crawl_type === "delta" ? "delta" : "http",
        batchSize: schedule.batch_size,
        minDelayMs: schedule.min_delay_ms,
        respectRobots: schedule.respect_robots,
        jsRenderMode: schedule.js_render_mode,
        pagespeedEnabled: schedule.pagespeed_enabled,
        pagespeedSampleSize: schedule.pagespeed_sample_size,
      });

      await supabase
        .from("technical_crawl_schedules")
        .update({
          status: "active",
          last_run_at: new Date().toISOString(),
          last_crawl_run_id: queued.runId,
          last_status:
            queued.status === "failed" || queued.status === "partial"
              ? queued.status
              : "running",
          last_error: null,
          failure_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", schedule.id)
        .eq("owner_id", schedule.owner_id);

      scheduleResults.push({
        schedule_id: schedule.id,
        name: schedule.name,
        status:
          queued.status === "failed" || queued.status === "partial"
            ? queued.status
            : "running",
        execution_mode: "queue",
        crawl_run_id: queued.runId,
        queued_urls: queued.queued,
        reused_running_run: queued.reused,
      });
    } catch (runError) {
      const failureCount = Number(schedule.failure_count || 0) + 1;
      const message =
        runError instanceof Error
          ? runError.message
          : "Scheduled technical crawl failed.";

      await supabase
        .from("technical_crawl_schedules")
        .update({
          status: failureCount >= 3 ? "failed" : "active",
          last_run_at: new Date().toISOString(),
          last_status: "failed",
          last_error: message,
          failure_count: failureCount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", schedule.id)
        .eq("owner_id", schedule.owner_id);

      scheduleResults.push({
        schedule_id: schedule.id,
        name: schedule.name,
        status: "failed",
        error: message,
      });
    }
  }

  // Refresh after schedule creation so a newly queued run can make progress
  // during the same invocation.
  const { data: frontierRuns, error: frontierError } = await supabase
    .from("crawl_runs")
    .select("id,owner_id,project_id,last_worker_at,created_at")
    .eq("execution_mode", "queue")
    .eq("status", "running")
    .order("last_worker_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(2);

  if (frontierError) {
    return NextResponse.json({ error: frontierError.message }, { status: 500 });
  }

  const crawlResults: Array<Record<string, unknown>> = [];
  let crawlFailed = 0;
  let crawlRetried = 0;

  for (const target of frontierRuns || []) {
    if (Date.now() + 30_000 >= deadlineAt) break;

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

    for (
      let batchIndex = 0;
      batchIndex < 3 &&
      Date.now() + 25_000 < deadlineAt &&
      !totals.complete;
      batchIndex += 1
    ) {
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

      if (
        result.complete ||
        (result.processed === 0 && result.queuedRemaining > 0)
      ) {
        break;
      }
    }

    await supabase
      .from("crawl_runs")
      .update({ last_worker_at: new Date().toISOString() })
      .eq("id", target.id)
      .eq("owner_id", target.owner_id);

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

    crawlFailed += totals.failed;
    crawlRetried += totals.retried;
    crawlResults.push({
      run_id: target.id,
      ...totals,
    });
  }

  let performanceResult: Record<string, unknown> | null = null;
  let performanceFailed = 0;
  let performanceRetried = 0;

  if (
    process.env.PAGESPEED_API_KEY &&
    Date.now() + 60_000 < deadlineAt
  ) {
    try {
      const result = await processPerformanceQueue({
        client: supabase,
        batchSize: 3,
      });
      performanceFailed = result.results.filter(
        (item) => item.status === "failed",
      ).length;
      performanceRetried = result.results.filter(
        (item) => item.status === "retry",
      ).length;
      performanceResult = {
        selected: result.selected,
        processed: result.processed,
        failed: performanceFailed,
        retry: performanceRetried,
      };
    } catch (performanceError) {
      performanceFailed = 1;
      performanceResult = {
        error:
          performanceError instanceof Error
            ? performanceError.message
            : "PageSpeed worker failed.",
      };
    }
  }

  const scheduleFailed = scheduleResults.filter(
    (item) => item.status === "failed",
  ).length;
  const schedulePartial = scheduleResults.filter(
    (item) => item.status === "partial",
  ).length;

  const processedCount =
    scheduleResults.length +
    crawlResults.reduce(
      (sum, result) => sum + Number(result.processed || 0),
      0,
    ) +
    Number(performanceResult?.processed || 0);

  const totalFailed = scheduleFailed + crawlFailed + performanceFailed;
  const totalPartial =
    schedulePartial + crawlRetried + performanceRetried;

  await finishRuntimeWorkerRun({
    client: supabase,
    tracker: runtimeRun,
    status: summarizeWorkerStatus({
      processed: Math.max(processedCount, 1),
      failed: totalFailed,
      partial: totalPartial,
    }),
    metrics: {
      recovered_stale_schedules: recoveredStaleSchedules,
      schedules_checked: schedules?.length || 0,
      schedules_due: due.length,
      schedules_started: scheduleResults.length,
      queue_runs_processed: crawlResults.length,
      queue_pages_processed: crawlResults.reduce(
        (sum, result) => sum + Number(result.processed || 0),
        0,
      ),
      pagespeed_processed: Number(performanceResult?.processed || 0),
      failed: totalFailed,
      partial: totalPartial,
      elapsed_ms: Date.now() - invocationStartedAt,
    },
  });

  return NextResponse.json({
    recovered_stale_schedules: recoveredStaleSchedules,
    schedules: {
      checked: schedules?.length || 0,
      due: due.length,
      results: scheduleResults,
    },
    distributed_crawl: crawlResults,
    pagespeed: performanceResult,
    elapsed_ms: Date.now() - invocationStartedAt,
    time: now.toISOString(),
  });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
