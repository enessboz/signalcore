import { NextRequest, NextResponse } from "next/server";
import { isScheduleDue, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
import { createAdminClient } from "@/lib/supabase/admin";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { recoverStaleCrawlSchedules } from "@/lib/runtime/recovery";
import { finishRuntimeWorkerRun, startRuntimeWorkerRun, summarizeWorkerStatus } from "@/lib/runtime/worker-runs";

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

  const { data: schedules, error } = await supabase
    .from("technical_crawl_schedules")
    .select("id,owner_id,project_id,name,crawl_type,max_urls,schedule_kind,schedule_config,timezone,status,last_run_at,last_status,last_error,failure_count")
    .eq("status", "active")
    .order("updated_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "technical-crawler",
    ownerIds: (schedules || []).map((item) => item.owner_id),
    metadata: { schedules_checked: schedules?.length || 0 },
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

  const results: Array<Record<string, unknown>> = [];

  for (const schedule of due) {
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
      const crawl = await runProjectCrawl({
        ownerId: schedule.owner_id,
        projectId: schedule.project_id,
        maxUrls: schedule.max_urls,
        crawlType: schedule.crawl_type === "delta" ? "delta" : "http",
        client: supabase,
      });

      const runStatus =
        Boolean(crawl.summary.runtime_limited) ||
        Number(crawl.summary.fetch_or_http_errors || 0) > 0
          ? "partial"
          : "succeeded";

      await supabase
        .from("technical_crawl_schedules")
        .update({
          status: "active",
          last_run_at: new Date().toISOString(),
          last_crawl_run_id: crawl.runId,
          last_status: runStatus,
          last_error: null,
          failure_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", schedule.id)
        .eq("owner_id", schedule.owner_id);

      results.push({
        schedule_id: schedule.id,
        name: schedule.name,
        status: runStatus,
        crawl_run_id: crawl.runId,
        summary: crawl.summary,
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

      results.push({
        schedule_id: schedule.id,
        name: schedule.name,
        status: "failed",
        error: message,
      });
    }
  }

  const failedCount = results.filter((item) => item.status === "failed").length;
  const partialCount = results.filter((item) => item.status === "partial").length;

  await finishRuntimeWorkerRun({
    client: supabase,
    tracker: runtimeRun,
    status: summarizeWorkerStatus({
      processed: Math.max(results.length, 1),
      failed: failedCount,
      partial: partialCount,
    }),
    metrics: {
      recovered_stale_schedules: recoveredStaleSchedules,
      checked: schedules?.length || 0,
      due: due.length,
      processed: results.length,
      failed: failedCount,
      partial: partialCount,
    },
  });

  return NextResponse.json({
    recovered_stale_schedules: recoveredStaleSchedules,
    checked: schedules?.length || 0,
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
