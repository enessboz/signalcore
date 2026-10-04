import { NextRequest, NextResponse } from "next/server";
import { processPerformanceQueue } from "@/lib/crawl/pagespeed";
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

  if (!process.env.PAGESPEED_API_KEY) {
    return NextResponse.json({
      status: "skipped",
      reason: "PAGESPEED_API_KEY is not configured.",
      time: new Date().toISOString(),
    });
  }

  const supabase = createAdminClient();
  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:crawl-performance",
    ttlSeconds: 300,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another crawl performance worker still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const { data: owners, error: ownerError } = await supabase
    .from("crawl_performance_queue")
    .select("owner_id")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .limit(50);

  if (ownerError) {
    return NextResponse.json({ error: ownerError.message }, { status: 500 });
  }

  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "crawl-performance",
    ownerIds: (owners || []).map((item) => item.owner_id),
    metadata: { queued_candidates: owners?.length || 0 },
  });

  try {
    const result = await processPerformanceQueue({
      client: supabase,
      batchSize: 5,
    });

    const failed = result.results.filter(
      (item) => item.status === "failed",
    ).length;
    const partial = result.results.filter(
      (item) => item.status === "retry",
    ).length;

    await finishRuntimeWorkerRun({
      client: supabase,
      tracker: runtimeRun,
      status: summarizeWorkerStatus({
        processed: Math.max(result.processed, 1),
        failed,
        partial,
      }),
      metrics: {
        selected: result.selected,
        processed: result.processed,
        failed,
        retry: partial,
      },
    });

    return NextResponse.json({
      status: "ok",
      ...result,
      time: new Date().toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Performance worker failed.";

    await finishRuntimeWorkerRun({
      client: supabase,
      tracker: runtimeRun,
      status: "failed",
      metrics: { processed: 0 },
      error: message,
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
