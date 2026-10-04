import type { SupabaseClient } from "@supabase/supabase-js";

function cutoffIso(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export async function recoverStaleGoogleSyncJobs(client: SupabaseClient) {
  const { data, error } = await client
    .from("google_sync_queue")
    .update({
      status: "queued",
      error: "Recovered after an interrupted worker invocation.",
      completed_at: null,
    })
    .eq("status", "running")
    .lt("started_at", cutoffIso(10))
    .select("id");

  if (error) throw new Error("Google sync recovery failed: " + error.message);
  return data?.length || 0;
}

export async function recoverStaleRankRuns(client: SupabaseClient) {
  const { data, error } = await client
    .from("rank_tracking_runs")
    .update({
      status: "failed",
      error: "Recovered stale rank run after worker interruption.",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", cutoffIso(15))
    .select("id");

  if (error) throw new Error("Rank run recovery failed: " + error.message);
  return data?.length || 0;
}

export async function recoverStaleCrawlSchedules(client: SupabaseClient) {
  const { data: stale, error } = await client
    .from("technical_crawl_schedules")
    .select("id,owner_id,failure_count")
    .eq("status", "running")
    .lt("updated_at", cutoffIso(15))
    .limit(100);

  if (error) throw new Error("Crawl schedule recovery failed: " + error.message);

  let recovered = 0;
  for (const row of stale || []) {
    const failures = Number(row.failure_count || 0) + 1;
    const { error: updateError } = await client
      .from("technical_crawl_schedules")
      .update({
        status: failures >= 3 ? "failed" : "active",
        last_status: "failed",
        last_error: "Recovered stale running crawl after worker interruption.",
        failure_count: failures,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("owner_id", row.owner_id)
      .eq("status", "running");

    if (updateError) {
      throw new Error("Crawl schedule recovery update failed: " + updateError.message);
    }
    recovered += 1;
  }

  return recovered;
}

export async function recoverStaleScheduledTasks(client: SupabaseClient) {
  const { data: stale, error } = await client
    .from("scheduled_tasks")
    .select("id,failure_count")
    .eq("status", "running")
    .lt("updated_at", cutoffIso(15))
    .limit(100);

  if (error) throw new Error("Agent schedule recovery failed: " + error.message);

  let recovered = 0;
  for (const row of stale || []) {
    const failures = Number(row.failure_count || 0) + 1;
    const { error: updateError } = await client
      .from("scheduled_tasks")
      .update({
        status: failures >= 3 ? "failed" : "active",
        last_error: "Recovered stale running task after worker interruption.",
        failure_count: failures,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "running");

    if (updateError) {
      throw new Error("Agent schedule recovery update failed: " + updateError.message);
    }
    recovered += 1;
  }

  return recovered;
}

export async function recoverStaleJobs(client: SupabaseClient) {
  const { data, error } = await client
    .from("jobs")
    .update({
      status: "failed",
      result_summary: {
        error: "Recovered stale running job after worker interruption.",
        recovered: true,
      },
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", cutoffIso(30))
    .select("id");

  if (error) throw new Error("Generic job recovery failed: " + error.message);
  return data?.length || 0;
}
