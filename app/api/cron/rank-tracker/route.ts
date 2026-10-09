import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { recoverStaleRankRuns } from "@/lib/runtime/recovery";
import {
  isTrackedKeywordDue,
  runRankTrackingBatch,
  seedTrackedKeywordsFromGsc,
  type TrackedKeywordRow,
} from "@/lib/seo/rank-tracking";
import { finishRuntimeWorkerRun, startRuntimeWorkerRun, summarizeWorkerStatus } from "@/lib/runtime/worker-runs";
import { refreshDueGscRankGroups } from "@/lib/seo/rank-groups";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_KEYWORDS_PER_INVOCATION = 15;
const MAX_PER_PROJECT = 7;

function olderThan(value: string | null, ms: number) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() >= ms;
}

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

  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    return NextResponse.json(
      { error: "DataForSEO credentials are not configured." },
      { status: 503 },
    );
  }

  const supabase = createAdminClient();
  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:rank-tracker",
    ttlSeconds: 360,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another rank tracker invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const recoveredStaleRuns = await recoverStaleRankRuns(supabase);
  const groupRefreshResults = await refreshDueGscRankGroups({
    client: supabase,
    maxGroups: 10,
  });

  const { data: autoSettings, error: settingsError } = await supabase
    .from("rank_tracking_settings")
    .select("project_id,owner_id,auto_discover_enabled,last_seeded_at,active")
    .eq("active", true)
    .limit(100);

  if (settingsError) {
    return NextResponse.json({ error: settingsError.message }, { status: 500 });
  }

  const runtimeRun = await startRuntimeWorkerRun({
    client: supabase,
    workerKey: "rank-tracker",
    ownerIds: (autoSettings || []).map((item) => item.owner_id),
    metadata: { auto_projects: autoSettings?.length || 0 },
  });

  const seedResults: Array<Record<string, unknown>> = [];
  for (const settings of autoSettings || []) {
    if (!settings.auto_discover_enabled) continue;
    if (!olderThan(settings.last_seeded_at, 24 * 3600_000)) continue;

    try {
      const seeded = await seedTrackedKeywordsFromGsc({
        ownerId: settings.owner_id,
        projectId: settings.project_id,
        client: supabase,
      });
      seedResults.push({
        project_id: settings.project_id,
        status: "succeeded",
        ...seeded,
      });
    } catch (error) {
      seedResults.push({
        project_id: settings.project_id,
        status: "failed",
        error: error instanceof Error ? error.message : "GSC auto seed failed.",
      });
    }
  }

  const { data: activeRows, error: keywordError } = await supabase
    .from("tracked_keywords")
    .select("id,project_id,owner_id,keyword,target_url,source,priority,cadence,depth,location_code,language_code,device,active,last_checked_at,last_position,last_ranking_url,last_status,last_error,consecutive_failures")
    .eq("active", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(1500);

  if (keywordError) {
    return NextResponse.json({ error: keywordError.message }, { status: 500 });
  }

  const due = ((activeRows || []) as TrackedKeywordRow[])
    .filter((row) => isTrackedKeywordDue(row))
    .sort((a, b) => {
      const weight = { high: 0, normal: 1, low: 2 };
      const p = weight[a.priority] - weight[b.priority];
      if (p) return p;
      const at = a.last_checked_at ? new Date(a.last_checked_at).getTime() : 0;
      const bt = b.last_checked_at ? new Date(b.last_checked_at).getTime() : 0;
      return at - bt;
    });

  const selected = due.slice(0, MAX_KEYWORDS_PER_INVOCATION);
  const grouped = new Map<string, TrackedKeywordRow[]>();

  for (const row of selected) {
    const key = row.project_id + "|" + row.owner_id;
    const list = grouped.get(key) || [];
    if (list.length < MAX_PER_PROJECT) list.push(row);
    grouped.set(key, list);
  }

  const runResults: Array<Record<string, unknown>> = [];
  let processedKeywords = 0;

  for (const [key, rows] of grouped) {
    if (!rows.length) continue;
    const [projectId, ownerId] = key.split("|");

    const { data: running } = await supabase
      .from("rank_tracking_runs")
      .select("id,started_at")
      .eq("project_id", projectId)
      .eq("owner_id", ownerId)
      .eq("status", "running")
      .gte(
        "started_at",
        new Date(Date.now() - 15 * 60_000).toISOString(),
      )
      .limit(1)
      .maybeSingle();

    if (running) {
      runResults.push({
        project_id: projectId,
        status: "skipped",
        reason: "A recent rank tracking run is still active.",
      });
      continue;
    }

    try {
      const result = await runRankTrackingBatch({
        ownerId,
        projectId,
        keywordIds: rows.map((row) => row.id),
        triggerType: "cron",
        limit: rows.length,
        onlyDue: false,
        client: supabase,
      });

      processedKeywords += result.completed;
      runResults.push({
        project_id: projectId,
        status: result.failed === 0 ? "succeeded" : "partial",
        run_id: result.runId,
        requested: result.requested,
        completed: result.completed,
        succeeded: result.succeeded,
        failed: result.failed,
        actual_cost: result.actualCost,
      });
    } catch (error) {
      runResults.push({
        project_id: projectId,
        status: "failed",
        error:
          error instanceof Error ? error.message : "Rank tracking batch failed.",
      });
    }
  }

  const failedRuns =
    runResults.filter((item) => item.status === "failed").length +
    seedResults.filter((item) => item.status === "failed").length;
  const partialRuns = runResults.filter((item) => item.status === "partial").length;

  await finishRuntimeWorkerRun({
    client: supabase,
    tracker: runtimeRun,
    status: summarizeWorkerStatus({
      processed: Math.max(runResults.length + seedResults.length, 1),
      failed: failedRuns,
      partial: partialRuns,
    }),
    metrics: {
      recovered_stale_runs: recoveredStaleRuns,
      rank_groups_refreshed: groupRefreshResults.filter(
        (item) => item.status === "succeeded",
      ).length,
      rank_groups_waiting_data: groupRefreshResults.filter(
        (item) => item.status === "waiting_data",
      ).length,
      rank_groups_failed: groupRefreshResults.filter(
        (item) => item.status === "failed",
      ).length,
      seed_projects: seedResults.length,
      active_keywords_checked: activeRows?.length || 0,
      due_keywords: due.length,
      selected_keywords: selected.length,
      processed_keywords: processedKeywords,
      project_runs: runResults.length,
      failed_runs: failedRuns,
      partial_runs: partialRuns,
    },
  });

  return NextResponse.json({
    recovered_stale_runs: recoveredStaleRuns,
    rank_group_refresh_results: groupRefreshResults,
    seed_results: seedResults,
    active_keywords_checked: activeRows?.length || 0,
    due_keywords: due.length,
    selected_keywords: selected.length,
    processed_keywords: processedKeywords,
    project_runs: runResults,
    time: new Date().toISOString(),
  });
}

// Vercel Cron invokes production cron routes with GET.
export async function GET(request: NextRequest) {
  return POST(request);
}
