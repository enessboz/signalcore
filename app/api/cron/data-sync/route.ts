import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueGoogleSync, processGoogleSyncJob } from "@/lib/google/sync";

export const runtime = "nodejs";
export const maxDuration = 300;

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function nextIsoDay(iso: string) {
  const date = new Date(iso + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// Leave headroom below the 300s function limit so queued work can checkpoint safely.
const SAFE_RUNTIME_MS = 240_000;

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

  const startedAt = Date.now();
  const supabase = createAdminClient();

  const { data: bindings, error: bindingError } = await supabase
    .from("project_bindings")
    .select("project_id,owner_id,binding_type,auto_sync_enabled")
    .eq("auto_sync_enabled", true)
    .in("binding_type", ["gsc", "ga4"]);

  if (bindingError) {
    return NextResponse.json({ error: bindingError.message }, { status: 500 });
  }

  const enqueueResults: Array<Record<string, unknown>> = [];

  for (const binding of bindings || []) {
    try {
      if (binding.binding_type === "gsc") {
        const end = isoDaysAgo(3);
        const start = isoDaysAgo(9);
        const id = await enqueueGoogleSync({
          ownerId: binding.owner_id,
          projectId: binding.project_id,
          source: "gsc",
          startDate: start,
          endDate: end,
          mode: "incremental",
          priority: 100,
          client: supabase,
        });
        enqueueResults.push({ project_id: binding.project_id, source: "gsc", job_id: id });
      }

      if (binding.binding_type === "ga4") {
        const end = isoDaysAgo(1);
        const start = isoDaysAgo(3);
        const id = await enqueueGoogleSync({
          ownerId: binding.owner_id,
          projectId: binding.project_id,
          source: "ga4",
          startDate: start,
          endDate: end,
          mode: "incremental",
          priority: 100,
          client: supabase,
        });
        enqueueResults.push({ project_id: binding.project_id, source: "ga4", job_id: id });
      }
    } catch (error) {
      enqueueResults.push({
        project_id: binding.project_id,
        source: binding.binding_type,
        error: error instanceof Error ? error.message : "Queueing failed",
      });
    }
  }

  const { data: jobs, error: queueError } = await supabase
    .from("google_sync_queue")
    .select("id,project_id,owner_id,source,mode,start_date,end_date,cursor_date,status,priority")
    .eq("status", "queued")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(6);

  if (queueError) {
    return NextResponse.json({ error: queueError.message }, { status: 500 });
  }

  const processed: Array<Record<string, unknown>> = [];

  for (const job of jobs || []) {
    if (Date.now() - startedAt >= SAFE_RUNTIME_MS) break;

    const maxDates = job.source === "gsc" ? 2 : 4;
    let currentJob = { ...job };
    let datesProcessed = 0;
    let rowsProcessed = 0;
    let completed = false;
    let lastDate: string | null = null;
    let failure: string | null = null;

    for (let step = 0; step < maxDates; step += 1) {
      if (Date.now() - startedAt >= SAFE_RUNTIME_MS) break;

      try {
        const result = await processGoogleSyncJob(currentJob, supabase);
        datesProcessed += result.date ? 1 : 0;
        rowsProcessed += Number(result.rows || 0);
        completed = result.completed;
        lastDate = result.date;

        if (result.completed || !result.date) break;

        currentJob = {
          ...currentJob,
          cursor_date: nextIsoDay(result.date),
          status: "queued",
        };
      } catch (error) {
        failure = error instanceof Error ? error.message : "Sync failed";
        break;
      }
    }

    processed.push({
      id: job.id,
      project_id: job.project_id,
      source: job.source,
      mode: job.mode,
      completed,
      dates_processed: datesProcessed,
      rows_processed: rowsProcessed,
      last_date: lastDate,
      error: failure,
    });
  }

  return NextResponse.json({
    bindings_checked: bindings?.length || 0,
    enqueue_results: enqueueResults,
    jobs_processed: processed.length,
    processed,
    elapsed_ms: Date.now() - startedAt,
    time: new Date().toISOString(),
  });
}
