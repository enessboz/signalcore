import type { SupabaseClient } from "@supabase/supabase-js";
import { runGa4Report } from "@/lib/google/analytics";
import { getProjectGoogleResource } from "@/lib/google/project-resource";
import { querySearchConsole, type GscRow } from "@/lib/google/search-console";
import { createClient } from "@/lib/supabase/server";

type SyncSource = "gsc" | "ga4";

type SyncJob = {
  id: string;
  project_id: string;
  owner_id: string;
  source: SyncSource;
  mode: "incremental" | "backfill" | "repair";
  start_date: string;
  end_date: string;
  cursor_date: string | null;
  status: string;
  attempt_count?: number;
  last_attempt_at?: string | null;
};

function addDays(iso: string, days: number) {
  const date = new Date(iso + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minIso(a: string, b: string) {
  return a <= b ? a : b;
}

function maxIso(a: string, b: string) {
  return a >= b ? a : b;
}

async function upsertChunks(
  supabase: SupabaseClient,
  table: string,
  rows: Array<Record<string, unknown>>,
  onConflict: string,
) {
  for (let index = 0; index < rows.length; index += 750) {
    const chunk = rows.slice(index, index + 750);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(table + " upsert failed: " + error.message);
  }
}

async function allGscRows(input: {
  supabase: SupabaseClient;
  siteUrl: string;
  date: string;
  dimensions: Array<"page" | "query">;
}) {
  const rows: GscRow[] = [];
  let startRow = 0;

  for (let page = 0; page < 12; page += 1) {
    const response = await querySearchConsole(
      {
        siteUrl: input.siteUrl,
        startDate: input.date,
        endDate: input.date,
        dimensions: input.dimensions,
        searchType: "web",
        dataState: "final",
        rowLimit: 25000,
        startRow,
      },
      input.supabase,
    );

    const batch = response.rows || [];
    rows.push(...batch);
    if (batch.length < 25000) break;
    startRow += batch.length;
  }

  return rows;
}

export async function syncGscDate(input: {
  supabase: SupabaseClient;
  ownerId: string;
  projectId: string;
  date: string;
}) {
  const resource = await getProjectGoogleResource(
    input.projectId,
    "gsc",
    input.supabase,
  );

  const [pageRows, queryRows, queryPageRows] = await Promise.all([
    allGscRows({
      supabase: input.supabase,
      siteUrl: resource.resource_id,
      date: input.date,
      dimensions: ["page"],
    }),
    allGscRows({
      supabase: input.supabase,
      siteUrl: resource.resource_id,
      date: input.date,
      dimensions: ["query"],
    }),
    allGscRows({
      supabase: input.supabase,
      siteUrl: resource.resource_id,
      date: input.date,
      dimensions: ["query", "page"],
    }),
  ]);

  await upsertChunks(
    input.supabase,
    "gsc_page_daily",
    pageRows
      .filter((row) => row.keys?.[0])
      .map((row) => ({
        project_id: input.projectId,
        owner_id: input.ownerId,
        date: input.date,
        search_type: "web",
        page: row.keys![0],
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        ctr: Number(row.ctr || 0),
        position: Number(row.position || 0),
        updated_at: new Date().toISOString(),
      })),
    "project_id,date,search_type,page",
  );

  await upsertChunks(
    input.supabase,
    "gsc_query_daily",
    queryRows
      .filter((row) => row.keys?.[0])
      .map((row) => ({
        project_id: input.projectId,
        owner_id: input.ownerId,
        date: input.date,
        search_type: "web",
        query: row.keys![0],
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        ctr: Number(row.ctr || 0),
        position: Number(row.position || 0),
        updated_at: new Date().toISOString(),
      })),
    "project_id,date,search_type,query",
  );

  await upsertChunks(
    input.supabase,
    "gsc_query_page_daily",
    queryPageRows
      .filter((row) => row.keys?.[0] && row.keys?.[1])
      .map((row) => ({
        project_id: input.projectId,
        owner_id: input.ownerId,
        date: input.date,
        search_type: "web",
        query: row.keys![0],
        page: row.keys![1],
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        ctr: Number(row.ctr || 0),
        position: Number(row.position || 0),
        updated_at: new Date().toISOString(),
      })),
    "project_id,date,search_type,query,page",
  );

  return {
    pageRows: pageRows.length,
    queryRows: queryRows.length,
    queryPageRows: queryPageRows.length,
    totalRows: pageRows.length + queryRows.length + queryPageRows.length,
  };
}

async function allGa4Rows(input: {
  supabase: SupabaseClient;
  property: string;
  date: string;
  dimensions: string[];
  metrics: string[];
}) {
  const rows: NonNullable<Awaited<ReturnType<typeof runGa4Report>>["rows"]> = [];
  let offset = 0;

  for (let page = 0; page < 20; page += 1) {
    const response = await runGa4Report(
      {
        property: input.property,
        startDate: input.date,
        endDate: input.date,
        dimensions: input.dimensions,
        metrics: input.metrics,
        limit: 10000,
        offset,
      },
      input.supabase,
    );

    const batch = response.rows || [];
    rows.push(...batch);
    offset += batch.length;

    if (!batch.length || batch.length < 10000 || offset >= Number(response.rowCount || 0)) {
      break;
    }
  }

  return rows;
}

function metric(row: { metricValues?: Array<{ value?: string }> }, index: number) {
  return Number(row.metricValues?.[index]?.value || 0);
}

export async function syncGa4Date(input: {
  supabase: SupabaseClient;
  ownerId: string;
  projectId: string;
  date: string;
}) {
  const resource = await getProjectGoogleResource(
    input.projectId,
    "ga4",
    input.supabase,
  );

  const [landingRows, eventRows] = await Promise.all([
    allGa4Rows({
      supabase: input.supabase,
      property: resource.resource_id,
      date: input.date,
      dimensions: ["landingPagePlusQueryString", "sessionPrimaryChannelGroup"],
      metrics: [
        "sessions",
        "activeUsers",
        "newUsers",
        "engagedSessions",
        "engagementRate",
        "keyEvents",
      ],
    }),
    allGa4Rows({
      supabase: input.supabase,
      property: resource.resource_id,
      date: input.date,
      dimensions: ["eventName"],
      metrics: ["eventCount", "activeUsers", "keyEvents"],
    }),
  ]);

  await upsertChunks(
    input.supabase,
    "ga4_landing_page_daily",
    landingRows
      .filter((row) => row.dimensionValues?.[0]?.value)
      .map((row) => ({
        project_id: input.projectId,
        owner_id: input.ownerId,
        date: input.date,
        landing_page: row.dimensionValues?.[0]?.value || "(not set)",
        channel_group: row.dimensionValues?.[1]?.value || "(not set)",
        sessions: metric(row, 0),
        active_users: metric(row, 1),
        new_users: metric(row, 2),
        engaged_sessions: metric(row, 3),
        engagement_rate: metric(row, 4),
        key_events: metric(row, 5),
        updated_at: new Date().toISOString(),
      })),
    "project_id,date,landing_page,channel_group",
  );

  await upsertChunks(
    input.supabase,
    "ga4_event_daily",
    eventRows
      .filter((row) => row.dimensionValues?.[0]?.value)
      .map((row) => ({
        project_id: input.projectId,
        owner_id: input.ownerId,
        date: input.date,
        event_name: row.dimensionValues?.[0]?.value || "(not set)",
        event_count: metric(row, 0),
        active_users: metric(row, 1),
        key_events: metric(row, 2),
        updated_at: new Date().toISOString(),
      })),
    "project_id,date,event_name",
  );

  return {
    landingRows: landingRows.length,
    eventRows: eventRows.length,
    totalRows: landingRows.length + eventRows.length,
  };
}

async function updateSyncState(input: {
  supabase: SupabaseClient;
  job: SyncJob;
  date: string;
  datasetRows: Record<string, number>;
}) {
  for (const [dataset, rows] of Object.entries(input.datasetRows)) {
    const { error } = await input.supabase.from("google_sync_states").upsert(
      {
        project_id: input.job.project_id,
        owner_id: input.job.owner_id,
        source: input.job.source,
        dataset,
        status: "succeeded",
        last_complete_date: input.date,
        last_attempt_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        rows_total: rows,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,source,dataset" },
    );
    if (error) throw new Error("Sync state update failed: " + error.message);
  }
}

async function updateSyncDateLog(input: {
  supabase: SupabaseClient;
  job: SyncJob;
  date: string;
  status: "succeeded" | "failed";
  totalRows?: number;
  datasetRows?: Record<string, number>;
  attemptCount?: number;
  lastError?: string | null;
}) {
  const now = new Date().toISOString();
  const { error } = await input.supabase.from("google_sync_date_log").upsert(
    {
      project_id: input.job.project_id,
      owner_id: input.job.owner_id,
      source: input.job.source,
      date: input.date,
      status: input.status,
      total_rows: Number(input.totalRows || 0),
      dataset_rows: input.datasetRows || {},
      attempt_count: Number(input.attemptCount || 0),
      last_error: input.lastError || null,
      last_attempt_at: now,
      succeeded_at: input.status === "succeeded" ? now : null,
      updated_at: now,
    },
    { onConflict: "project_id,source,date" },
  );

  if (error) throw new Error("Sync date log update failed: " + error.message);
}

export async function processGoogleSyncJob(
  job: SyncJob,
  client?: SupabaseClient,
) {
  const supabase = client || (await createClient());
  const date = job.cursor_date || job.start_date;

  if (date > job.end_date) {
    await supabase
      .from("google_sync_queue")
      .update({
        status: "succeeded",
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return { completed: true, date: null, rows: 0 };
  }

  await supabase
    .from("google_sync_queue")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", job.id);

  try {
    let totalRows = 0;
    let datasetRows: Record<string, number>;

    if (job.source === "gsc") {
      const result = await syncGscDate({
        supabase,
        ownerId: job.owner_id,
        projectId: job.project_id,
        date,
      });

      totalRows = result.totalRows;
      datasetRows = {
        page_daily: result.pageRows,
        query_daily: result.queryRows,
        query_page_daily: result.queryPageRows,
      };
    } else {
      const result = await syncGa4Date({
        supabase,
        ownerId: job.owner_id,
        projectId: job.project_id,
        date,
      });

      totalRows = result.totalRows;
      datasetRows = {
        landing_page_daily: result.landingRows,
        event_daily: result.eventRows,
      };
    }

    await updateSyncState({
      supabase,
      job,
      date,
      datasetRows,
    });

    await updateSyncDateLog({
      supabase,
      job,
      date,
      status: "succeeded",
      totalRows,
      datasetRows,
      attemptCount: 0,
      lastError: null,
    });

    const nextDate = addDays(date, 1);
    const completed = nextDate > job.end_date;

    const { error } = await supabase
      .from("google_sync_queue")
      .update({
        status: completed ? "succeeded" : "queued",
        cursor_date: completed ? date : nextDate,
        result: {
          last_date: date,
          last_rows: totalRows,
          source: job.source,
          dataset_rows: datasetRows,
        },
        attempt_count: 0,
        last_attempt_at: new Date().toISOString(),
        error: null,
        completed_at: completed ? new Date().toISOString() : null,
      })
      .eq("id", job.id);

    if (error) throw error;
    return { completed, date, rows: totalRows };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google sync failed.";
    const attemptCount = Number(job.attempt_count || 0) + 1;
    const terminalFailure = attemptCount >= 3;

    await supabase
      .from("google_sync_queue")
      .update({
        status: terminalFailure ? "failed" : "queued",
        attempt_count: attemptCount,
        last_attempt_at: new Date().toISOString(),
        error: message,
        completed_at: terminalFailure ? new Date().toISOString() : null,
      })
      .eq("id", job.id);

    await updateSyncDateLog({
      supabase,
      job,
      date,
      status: "failed",
      totalRows: 0,
      datasetRows: {},
      attemptCount,
      lastError: message,
    });

    const datasets =
      job.source === "gsc"
        ? ["page_daily", "query_daily", "query_page_daily"]
        : ["landing_page_daily", "event_daily"];

    for (const dataset of datasets) {
      await supabase.from("google_sync_states").upsert(
        {
          project_id: job.project_id,
          owner_id: job.owner_id,
          source: job.source,
          dataset,
          status: terminalFailure ? "failed" : "queued",
          last_attempt_at: new Date().toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id,source,dataset" },
      );
    }

    throw error;
  }
}

export async function enqueueGoogleSync(input: {
  ownerId: string;
  projectId: string;
  source: SyncSource;
  startDate: string;
  endDate: string;
  mode?: "incremental" | "backfill" | "repair";
  priority?: number;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const startDate = minIso(input.startDate, input.endDate);
  const endDate = maxIso(input.startDate, input.endDate);

  const mode = input.mode || "incremental";
  const { data: existing } = await supabase
    .from("google_sync_queue")
    .select("id")
    .eq("project_id", input.projectId)
    .eq("source", input.source)
    .eq("mode", mode)
    .in("status", ["queued", "running"])
    .limit(1)
    .maybeSingle();

  if (existing) return existing.id as string;

  const { data, error } = await supabase
    .from("google_sync_queue")
    .insert({
      project_id: input.projectId,
      owner_id: input.ownerId,
      source: input.source,
      mode,
      start_date: startDate,
      end_date: endDate,
      cursor_date: startDate,
      status: "queued",
      priority: input.priority || 50,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Google sync job could not be queued.");
  }

  return data.id as string;
}
