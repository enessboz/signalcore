import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type GscRankGroupMetric = "clicks" | "impressions";

type GscTopQuery = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  rank_order: number;
};

type TopQueryPayload = {
  available?: boolean;
  metric?: GscRankGroupMetric;
  requested_days?: number;
  coverage_days?: number;
  current_start?: string | null;
  current_end?: string | null;
  rows?: GscTopQuery[];
};

function dayDiff(start: string, end: string) {
  const a = new Date(start + "T00:00:00Z").getTime();
  const b = new Date(end + "T00:00:00Z").getTime();
  return Math.floor((b - a) / 86_400_000);
}

function isRefreshDue(
  lastRefreshedAt: string | null,
  cadence: "daily" | "weekly",
) {
  if (!lastRefreshedAt) return true;
  const age = Date.now() - new Date(lastRefreshedAt).getTime();
  return age >= (cadence === "weekly" ? 7 : 1) * 86_400_000;
}

function groupDefinition(metric: GscRankGroupMetric, days: number) {
  return metric === "clicks"
    ? {
        name: "Top Clicks · " + days + "d",
        key: "gsc_top_clicks_" + days + "d",
        source: "gsc_top_clicks",
      }
    : {
        name: "Top Impressions · " + days + "d",
        key: "gsc_top_impressions_" + days + "d",
        source: "gsc_top_impressions",
      };
}

async function ensureGroup(input: {
  client: SupabaseClient;
  ownerId: string;
  projectId: string;
  metric: GscRankGroupMetric;
  days: number;
  limit: number;
  autoRefresh: boolean;
  refreshCadence: "daily" | "weekly";
}) {
  const definition = groupDefinition(input.metric, input.days);
  const { data, error } = await input.client
    .from("rank_keyword_groups")
    .upsert(
      {
        project_id: input.projectId,
        owner_id: input.ownerId,
        name: definition.name,
        group_key: definition.key,
        source: definition.source,
        metric: input.metric,
        window_days: input.days,
        keyword_limit: input.limit,
        auto_refresh_enabled: input.autoRefresh,
        refresh_cadence: input.refreshCadence,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,owner_id,group_key" },
    )
    .select("id,name,group_key,last_refreshed_at")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Rank keyword group could not be created.");
  }

  return data as {
    id: string;
    name: string;
    group_key: string;
    last_refreshed_at: string | null;
  };
}

async function warehouseWindowReady(input: {
  client: SupabaseClient;
  projectId: string;
  days: number;
}) {
  const [{ data: oldest }, { data: newest }, { data: syncState }] =
    await Promise.all([
      input.client
        .from("gsc_query_daily")
        .select("date")
        .eq("project_id", input.projectId)
        .order("date", { ascending: true })
        .limit(1)
        .maybeSingle(),
      input.client
        .from("gsc_query_daily")
        .select("date")
        .eq("project_id", input.projectId)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      input.client
        .from("google_sync_states")
        .select("status,last_complete_date,last_success_at,last_error")
        .eq("project_id", input.projectId)
        .eq("source", "gsc")
        .eq("dataset", "query_daily")
        .maybeSingle(),
    ]);

  if (!oldest?.date || !newest?.date) {
    return {
      ready: false as const,
      reason: "GSC query warehouse has no rows yet.",
      oldestDate: oldest?.date || null,
      newestDate: newest?.date || null,
      syncState: syncState || null,
    };
  }

  const spanDays = dayDiff(oldest.date, newest.date) + 1;
  if (spanDays < input.days) {
    return {
      ready: false as const,
      reason:
        "GSC query warehouse currently spans " +
        spanDays +
        " day(s); " +
        input.days +
        " day(s) are required.",
      oldestDate: oldest.date,
      newestDate: newest.date,
      syncState: syncState || null,
    };
  }

  return {
    ready: true as const,
    oldestDate: oldest.date,
    newestDate: newest.date,
    syncState: syncState || null,
  };
}

async function syncOneGroup(input: {
  client: SupabaseClient;
  ownerId: string;
  projectId: string;
  metric: GscRankGroupMetric;
  days: number;
  limit: number;
  autoRefresh: boolean;
  refreshCadence: "daily" | "weekly";
  force?: boolean;
}) {
  const group = await ensureGroup(input);

  if (!input.force && !isRefreshDue(group.last_refreshed_at, input.refreshCadence)) {
    return {
      groupId: group.id,
      groupName: group.name,
      metric: input.metric,
      refreshed: false,
      waitingData: false,
      keywords: 0,
      dataDate: null as string | null,
    };
  }

  const window = await warehouseWindowReady({
    client: input.client,
    projectId: input.projectId,
    days: input.days,
  });

  if (!window.ready) {
    await input.client
      .from("rank_keyword_groups")
      .update({
        last_status: "partial",
        last_error: window.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", group.id)
      .eq("owner_id", input.ownerId);

    return {
      groupId: group.id,
      groupName: group.name,
      metric: input.metric,
      refreshed: false,
      waitingData: true,
      keywords: 0,
      dataDate: window.newestDate,
      reason: window.reason,
    };
  }

  await input.client
    .from("rank_keyword_groups")
    .update({
      last_status: "refreshing",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", group.id)
    .eq("owner_id", input.ownerId);

  const { data, error } = await input.client.rpc("get_gsc_top_queries", {
    p_project_id: input.projectId,
    p_days: input.days,
    p_metric: input.metric,
    p_limit: input.limit,
  });
  if (error) {
    throw new Error("GSC top-query selection failed: " + error.message);
  }

  const payload = (data || {}) as TopQueryPayload;
  const rows = (payload.rows || []).filter((row) => row.query?.trim());

  const { data: settings } = await input.client
    .from("rank_tracking_settings")
    .select("default_location_code,default_language_code,default_device")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .maybeSingle();

  const locationCode = Number(settings?.default_location_code || 2840);
  const languageCode = String(settings?.default_language_code || "en");
  const device = settings?.default_device === "mobile" ? "mobile" : "desktop";

  const { data: existingKeywords, error: existingError } = await input.client
    .from("tracked_keywords")
    .select("id,keyword,source,active")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .eq("location_code", locationCode)
    .eq("language_code", languageCode)
    .eq("device", device)
    .limit(5000);

  if (existingError) throw new Error(existingError.message);

  const byKeyword = new Map(
    (existingKeywords || []).map((row) => [row.keyword.trim().toLowerCase(), row]),
  );

  const missing = rows
    .filter((row) => !byKeyword.has(row.query.trim().toLowerCase()))
    .map((row) => ({
      project_id: input.projectId,
      owner_id: input.ownerId,
      keyword: row.query.trim(),
      source: "gsc_group",
      priority: "high",
      cadence: input.refreshCadence === "daily" ? "daily" : "weekly",
      depth: 30,
      location_code: locationCode,
      language_code: languageCode,
      device,
      active: true,
      updated_at: new Date().toISOString(),
    }));

  if (missing.length) {
    const { error: insertError } = await input.client
      .from("tracked_keywords")
      .insert(missing);
    if (insertError) throw new Error("Tracked keyword insert failed: " + insertError.message);
  }

  const requested = rows.map((row) => row.query.trim().toLowerCase());
  const { data: tracked, error: trackedError } = await input.client
    .from("tracked_keywords")
    .select("id,keyword")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .eq("location_code", locationCode)
    .eq("language_code", languageCode)
    .eq("device", device)
    .in("keyword", rows.map((row) => row.query.trim()));

  if (trackedError) throw new Error(trackedError.message);

  const trackedByKeyword = new Map(
    (tracked || []).map((row) => [row.keyword.trim().toLowerCase(), row.id as string]),
  );

  // Case-insensitive fall-back for providers that normalize query casing differently.
  if (trackedByKeyword.size < requested.length) {
    const { data: fallbackRows } = await input.client
      .from("tracked_keywords")
      .select("id,keyword")
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .eq("location_code", locationCode)
      .eq("language_code", languageCode)
      .eq("device", device)
      .limit(5000);
    for (const row of fallbackRows || []) {
      trackedByKeyword.set(row.keyword.trim().toLowerCase(), row.id);
    }
  }

  const members = rows
    .map((row) => {
      const trackedKeywordId = trackedByKeyword.get(row.query.trim().toLowerCase());
      if (!trackedKeywordId) return null;
      return {
        group_id: group.id,
        tracked_keyword_id: trackedKeywordId,
        project_id: input.projectId,
        owner_id: input.ownerId,
        rank_order: Number(row.rank_order || 0),
        metric_value:
          input.metric === "clicks" ? Number(row.clicks || 0) : Number(row.impressions || 0),
        secondary_metric_value:
          input.metric === "clicks" ? Number(row.impressions || 0) : Number(row.clicks || 0),
        source_snapshot: {
          clicks: Number(row.clicks || 0),
          impressions: Number(row.impressions || 0),
          ctr: Number(row.ctr || 0),
          position: Number(row.position || 0),
          window_days: input.days,
          data_start: payload.current_start || null,
          data_end: payload.current_end || null,
        },
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean);

  const { error: deleteError } = await input.client
    .from("rank_keyword_group_members")
    .delete()
    .eq("group_id", group.id)
    .eq("owner_id", input.ownerId);
  if (deleteError) throw new Error(deleteError.message);

  if (members.length) {
    const { error: memberError } = await input.client
      .from("rank_keyword_group_members")
      .insert(members);
    if (memberError) throw new Error("Rank group membership failed: " + memberError.message);
  }

  await input.client
    .from("rank_keyword_groups")
    .update({
      last_refreshed_at: new Date().toISOString(),
      last_data_date: payload.current_end || window.newestDate,
      last_status: "succeeded",
      last_error: null,
      metadata: {
        current_start: payload.current_start || null,
        current_end: payload.current_end || window.newestDate,
        selected_keywords: members.length,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", group.id)
    .eq("owner_id", input.ownerId);

  return {
    groupId: group.id,
    groupName: group.name,
    metric: input.metric,
    refreshed: true,
    waitingData: false,
    keywords: members.length,
    dataDate: payload.current_end || window.newestDate,
    rows,
  };
}

export async function syncGscRankGroups(input: {
  ownerId: string;
  projectId: string;
  days?: number;
  limit?: number;
  metrics?: GscRankGroupMetric[];
  autoRefresh?: boolean;
  refreshCadence?: "daily" | "weekly";
  force?: boolean;
  client?: SupabaseClient;
}) {
  const client = input.client || (await createClient());
  const days = Math.min(Math.max(Number(input.days || 28), 1), 480);
  const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
  const metrics = Array.from(
    new Set(input.metrics?.length ? input.metrics : ["clicks", "impressions"]),
  );
  const refreshCadence = input.refreshCadence || "daily";

  await client.from("rank_tracking_settings").upsert(
    {
      project_id: input.projectId,
      owner_id: input.ownerId,
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  const groups = [];
  for (const metric of metrics) {
    groups.push(
      await syncOneGroup({
        client,
        ownerId: input.ownerId,
        projectId: input.projectId,
        metric,
        days,
        limit,
        autoRefresh: input.autoRefresh !== false,
        refreshCadence,
        force: input.force,
      }),
    );
  }

  return {
    days,
    limit,
    groups,
    waitingData: groups.some((group) => group.waitingData),
    refreshedGroups: groups.filter((group) => group.refreshed).length,
    selectedKeywords: groups.reduce((sum, group) => sum + Number(group.keywords || 0), 0),
  };
}

async function settleWaitingRankGroupPlans(input: {
  client: SupabaseClient;
  projectId: string;
  ownerId: string;
}) {
  const { data: waitingSteps, error } = await input.client
    .from("command_plan_steps")
    .select("id,plan_id,arguments,result")
    .eq("owner_id", input.ownerId)
    .eq("action_type", "create_rank_groups_from_gsc")
    .eq("status", "waiting_data")
    .order("updated_at", { ascending: true })
    .limit(50);

  if (error) return;

  for (const step of waitingSteps || []) {
    const result =
      step.result && typeof step.result === "object"
        ? (step.result as Record<string, unknown>)
        : {};
    if (String(result.projectId || "") !== input.projectId) continue;

    const args =
      step.arguments && typeof step.arguments === "object"
        ? (step.arguments as Record<string, unknown>)
        : {};
    const days = Math.min(
      Math.max(Number(args.performance_window_days || 28), 1),
      480,
    );
    const rawMetrics = Array.isArray(args.rank_group_metrics)
      ? args.rank_group_metrics.map(String)
      : ["clicks", "impressions"];
    const metrics = rawMetrics.filter(
      (metric): metric is GscRankGroupMetric =>
        metric === "clicks" || metric === "impressions",
    );
    const expected = (metrics.length ? metrics : ["clicks", "impressions"]).map(
      (metric) => groupDefinition(metric as GscRankGroupMetric, days).key,
    );

    const { data: groups } = await input.client
      .from("rank_keyword_groups")
      .select("id,group_key,name,last_status,last_data_date,last_refreshed_at")
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .in("group_key", expected);

    const ready =
      (groups || []).length === expected.length &&
      (groups || []).every(
        (group) => group.last_status === "succeeded" && group.last_refreshed_at,
      );
    if (!ready) continue;

    const now = new Date().toISOString();
    await input.client
      .from("command_plan_steps")
      .update({
        status: "completed",
        result: {
          ...result,
          auto_resumed: true,
          completed_from_background_data: true,
          groups: groups || [],
        },
        blocker_type: null,
        blocker_message: null,
        required_input: {},
        completed_at: now,
        updated_at: now,
      })
      .eq("id", step.id)
      .eq("owner_id", input.ownerId);

    const { count: remaining } = await input.client
      .from("command_plan_steps")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", step.plan_id)
      .in("status", [
        "pending",
        "running",
        "waiting_data",
        "waiting_user",
        "blocked_tool",
      ]);

    await input.client
      .from("command_plans")
      .update({
        status: remaining ? "planned" : "completed",
        last_error: null,
        completed_at: remaining ? null : now,
        updated_at: now,
      })
      .eq("id", step.plan_id)
      .eq("owner_id", input.ownerId);
  }
}

export async function refreshDueGscRankGroups(input: {
  client: SupabaseClient;
  maxGroups?: number;
}) {
  const { data: groups, error } = await input.client
    .from("rank_keyword_groups")
    .select("project_id,owner_id,window_days,keyword_limit,metric,refresh_cadence,last_refreshed_at")
    .eq("auto_refresh_enabled", true)
    .in("source", ["gsc_top_clicks", "gsc_top_impressions"])
    .neq("last_status", "paused")
    .order("last_refreshed_at", { ascending: true, nullsFirst: true })
    .limit(Math.min(Math.max(input.maxGroups || 20, 1), 100));

  if (error) throw new Error(error.message);

  const results = [];
  const touchedProjects = new Map<string, { projectId: string; ownerId: string }>();
  for (const group of groups || []) {
    const cadence = group.refresh_cadence === "weekly" ? "weekly" : "daily";
    if (!isRefreshDue(group.last_refreshed_at, cadence)) continue;
    const metric = group.metric === "impressions" ? "impressions" : "clicks";

    try {
      const result = await syncGscRankGroups({
        ownerId: group.owner_id,
        projectId: group.project_id,
        days: group.window_days,
        limit: group.keyword_limit,
        metrics: [metric],
        autoRefresh: true,
        refreshCadence: cadence,
        force: true,
        client: input.client,
      });
      results.push({
        project_id: group.project_id,
        metric,
        status: result.waitingData ? "waiting_data" : "succeeded",
      });
      touchedProjects.set(group.project_id + "|" + group.owner_id, {
        projectId: group.project_id,
        ownerId: group.owner_id,
      });
    } catch (error) {
      results.push({
        project_id: group.project_id,
        metric,
        status: "failed",
        error: error instanceof Error ? error.message : "Group refresh failed.",
      });
    }
  }

  for (const project of touchedProjects.values()) {
    await settleWaitingRankGroupPlans({
      client: input.client,
      projectId: project.projectId,
      ownerId: project.ownerId,
    });
  }

  return results;
}
