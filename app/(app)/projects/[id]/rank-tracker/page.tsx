import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { getLocale } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import {
  addTrackedKeywords,
  assignRankTag,
  createRankTag,
  deleteRankTag,
  runRankCheckFromForm,
  saveRankTrackingSettings,
  seedFromGsc,
} from "./actions";
import { RankTrackerWorkspace } from "./rank-tracker-workspace";

export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function isoDaysBefore(endDate: string, days: number) {
  const date = new Date(endDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export default async function RankTrackerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const locale = await getLocale();
  const supabase = await createClient();

  const [
    { data: project },
    { data: settings },
    { data: keywords },
    { data: recentHistory },
    { data: gscState },
    { data: usage },
    { data: keywordGroups },
    { data: groupMembers },
    { data: manualTags },
    { data: tagMembers },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,domain,project_type")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("rank_tracking_settings")
      .select("*")
      .eq("project_id", id)
      .maybeSingle(),
    supabase
      .from("tracked_keywords")
      .select(
        "id,keyword,target_url,source,priority,cadence,depth,location_code,language_code,device,active,last_checked_at,last_position,last_ranking_url,last_status,last_error,consecutive_failures,created_at",
      )
      .eq("project_id", id)
      .order("priority")
      .order("keyword")
      .limit(3000),
    supabase
      .from("rank_history")
      .select(
        "id,tracked_keyword_id,checked_at,position,ranking_url,ranking_title,matched_domain,organic_result_count,serp_features,top_competitors,cost,metadata",
      )
      .eq("project_id", id)
      .order("checked_at", { ascending: false })
      .limit(8000),
    supabase
      .from("google_sync_states")
      .select("last_complete_date,last_success_at,status,last_error")
      .eq("project_id", id)
      .eq("source", "gsc")
      .eq("dataset", "query_daily")
      .maybeSingle(),
    supabase
      .from("usage_events")
      .select("actual_cost,estimated_cost,created_at")
      .eq("project_id", id)
      .eq("category", "serp")
      .gte(
        "created_at",
        new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
        ).toISOString(),
      ),
    supabase
      .from("rank_keyword_groups")
      .select(
        "id,name,group_key,source,metric,window_days,keyword_limit,auto_refresh_enabled,refresh_cadence,last_refreshed_at,last_data_date,last_status,last_error,metadata",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("rank_keyword_group_members")
      .select(
        "group_id,tracked_keyword_id,rank_order,metric_value,secondary_metric_value,source_snapshot",
      )
      .eq("project_id", id)
      .order("rank_order", { ascending: true }),
    supabase
      .from("rank_keyword_tags")
      .select("id,name,slug,color_key,created_at,updated_at")
      .eq("project_id", id)
      .order("name"),
    supabase
      .from("rank_keyword_tag_members")
      .select("tag_id,tracked_keyword_id")
      .eq("project_id", id),
  ]);

  if (!project) notFound();

  const config = settings || {
    active: true,
    auto_discover_enabled: false,
    auto_findings_enabled: true,
    max_auto_keywords: 100,
    min_impressions_28d: 100,
    position_min: 1,
    position_max: 30,
    default_location_code: 2840,
    default_language_code: "en",
    default_device: "desktop",
    daily_high_priority_limit: 20,
    last_seeded_at: null,
    last_worker_run_at: null,
  };

  const keywordNames = Array.from(
    new Set((keywords || []).map((item) => item.keyword).filter(Boolean)),
  );
  const fallbackEnd = new Date(Date.now() - 2 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const gscEnd = gscState?.last_complete_date || fallbackEnd;
  const gscStart = isoDaysBefore(gscEnd, 29);

  const { data: gscRows } = keywordNames.length
    ? await supabase
        .from("gsc_query_daily")
        .select("query,date,clicks,impressions,ctr,position")
        .eq("project_id", id)
        .in("query", keywordNames.slice(0, 1000))
        .gte("date", gscStart)
        .lte("date", gscEnd)
        .limit(15000)
    : { data: [] };

  const gscByQuery = new Map<
    string,
    {
      clicks: number;
      impressions: number;
      weightedPosition: number;
      weight: number;
    }
  >();

  for (const row of gscRows || []) {
    const key = String(row.query || "").trim().toLocaleLowerCase("en-US");
    if (!key) continue;
    const current = gscByQuery.get(key) || {
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
      weight: 0,
    };
    const impressions = Number(row.impressions || 0);
    current.clicks += Number(row.clicks || 0);
    current.impressions += impressions;
    current.weightedPosition += Number(row.position || 0) * Math.max(impressions, 1);
    current.weight += Math.max(impressions, 1);
    gscByQuery.set(key, current);
  }

  const historiesByKeyword = new Map<
    string,
    NonNullable<typeof recentHistory>
  >();
  for (const row of recentHistory || []) {
    const list = historiesByKeyword.get(row.tracked_keyword_id) || [];
    if (list.length < 45) list.push(row);
    historiesByKeyword.set(row.tracked_keyword_id, list);
  }

  const groupsByKeyword = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  const groupById = new Map(
    (keywordGroups || []).map((group) => [group.id, group] as const),
  );
  for (const member of groupMembers || []) {
    const group = groupById.get(member.group_id);
    if (!group) continue;
    const list = groupsByKeyword.get(member.tracked_keyword_id) || [];
    list.push({
      id: group.id,
      name: group.name,
      color: group.metric === "impressions" ? "blue" : "purple",
    });
    groupsByKeyword.set(member.tracked_keyword_id, list);
  }

  const tagsByKeyword = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  const tagById = new Map(
    (manualTags || []).map((tag) => [tag.id, tag] as const),
  );
  for (const member of tagMembers || []) {
    const tag = tagById.get(member.tag_id);
    if (!tag) continue;
    const list = tagsByKeyword.get(member.tracked_keyword_id) || [];
    list.push({
      id: tag.id,
      name: tag.name,
      color: tag.color_key || "purple",
    });
    tagsByKeyword.set(member.tracked_keyword_id, list);
  }

  const shapedKeywords = (keywords || []).map((keyword) => {
    const history = historiesByKeyword.get(keyword.id) || [];
    const latest = history[0] || null;
    const previous = history[1] || null;
    const bestPosition = history
      .map((item) =>
        item.position === null || item.position === undefined
          ? null
          : Number(item.position),
      )
      .filter((value): value is number => value !== null)
      .reduce<number | null>(
        (best, value) => (best === null || value < best ? value : best),
        null,
      );
    const gsc =
      gscByQuery.get(keyword.keyword.trim().toLocaleLowerCase("en-US")) || null;
    const clicks = Number(gsc?.clicks || 0);
    const impressions = Number(gsc?.impressions || 0);

    return {
      id: keyword.id,
      keyword: keyword.keyword,
      targetUrl: keyword.target_url,
      source: keyword.source,
      priority: keyword.priority,
      cadence: keyword.cadence,
      depth: Number(keyword.depth || 30),
      locationCode: Number(keyword.location_code || 2840),
      languageCode: keyword.language_code || "en",
      device: keyword.device || "desktop",
      active: Boolean(keyword.active),
      lastCheckedAt: keyword.last_checked_at,
      lastPosition:
        keyword.last_position === null || keyword.last_position === undefined
          ? null
          : Number(keyword.last_position),
      lastRankingUrl: keyword.last_ranking_url,
      lastStatus: keyword.last_status || "idle",
      lastError: keyword.last_error,
      latestPosition:
        latest?.position === null || latest?.position === undefined
          ? null
          : Number(latest.position),
      previousPosition:
        previous?.position === null || previous?.position === undefined
          ? null
          : Number(previous.position),
      bestPosition,
      gscClicks: clicks,
      gscImpressions: impressions,
      gscCtr: impressions ? clicks / impressions : 0,
      groups: groupsByKeyword.get(keyword.id) || [],
      tags: tagsByKeyword.get(keyword.id) || [],
    };
  });

  type HistoryRow = NonNullable<typeof recentHistory>[number];
  const latestHistoryByKeyword = new Map<string, HistoryRow>();
  for (const row of recentHistory || []) {
    if (!latestHistoryByKeyword.has(row.tracked_keyword_id)) {
      latestHistoryByKeyword.set(row.tracked_keyword_id, row);
    }
  }

  const dailyKeywordLatest = new Map<
    string,
    { date: string; keywordId: string; position: number | null }
  >();
  for (const row of recentHistory || []) {
    const date = String(row.checked_at).slice(0, 10);
    const key = date + "|" + row.tracked_keyword_id;
    if (!dailyKeywordLatest.has(key)) {
      dailyKeywordLatest.set(key, {
        date,
        keywordId: row.tracked_keyword_id,
        position:
          row.position === null || row.position === undefined
            ? null
            : Number(row.position),
      });
    }
  }

  const trendBuckets = new Map<
    string,
    {
      positionSum: number;
      ranked: number;
      visibilitySum: number;
      checked: number;
    }
  >();

  for (const item of dailyKeywordLatest.values()) {
    const bucket = trendBuckets.get(item.date) || {
      positionSum: 0,
      ranked: 0,
      visibilitySum: 0,
      checked: 0,
    };
    bucket.checked += 1;
    if (item.position !== null) {
      bucket.positionSum += item.position;
      bucket.ranked += 1;
      bucket.visibilitySum +=
        Math.max(0, 1 - (Math.min(item.position, 100) - 1) / 100) * 100;
    }
    trendBuckets.set(item.date, bucket);
  }

  const trend = Array.from(trendBuckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, bucket]) => ({
      date,
      avgPosition: bucket.ranked
        ? bucket.positionSum / bucket.ranked
        : 0,
      visibility: bucket.checked
        ? bucket.visibilitySum / bucket.checked
        : 0,
      checked: bucket.checked,
    }));

  const landingMap = new Map<
    string,
    {
      url: string;
      keywordCount: number;
      positionSum: number;
      ranked: number;
      top10: number;
      clicks: number;
      impressions: number;
    }
  >();

  for (const item of shapedKeywords) {
    const url = item.lastRankingUrl || item.targetUrl;
    if (!url) continue;
    const current = landingMap.get(url) || {
      url,
      keywordCount: 0,
      positionSum: 0,
      ranked: 0,
      top10: 0,
      clicks: 0,
      impressions: 0,
    };
    current.keywordCount += 1;
    if (item.lastPosition !== null) {
      current.ranked += 1;
      current.positionSum += item.lastPosition;
      if (item.lastPosition <= 10) current.top10 += 1;
    }
    current.clicks += item.gscClicks;
    current.impressions += item.gscImpressions;
    landingMap.set(url, current);
  }

  const landingPages = Array.from(landingMap.values())
    .map((item) => ({
      url: item.url,
      keywordCount: item.keywordCount,
      avgPosition: item.ranked ? item.positionSum / item.ranked : null,
      top10: item.top10,
      clicks: item.clicks,
      impressions: item.impressions,
    }))
    .sort(
      (a, b) =>
        b.clicks - a.clicks ||
        b.keywordCount - a.keywordCount ||
        (a.avgPosition || 999) - (b.avgPosition || 999),
    )
    .slice(0, 100);

  const competitorMap = new Map<
    string,
    { appearances: number; rankSum: number; rankCount: number }
  >();
  const featureMap = new Map<string, number>();

  for (const row of latestHistoryByKeyword.values()) {
    for (const raw of asArray(row.top_competitors)) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const domain = String(item.domain || "").trim();
      if (!domain) continue;
      const rank = Number(item.rank || 0);
      const current = competitorMap.get(domain) || {
        appearances: 0,
        rankSum: 0,
        rankCount: 0,
      };
      current.appearances += 1;
      if (rank > 0) {
        current.rankSum += rank;
        current.rankCount += 1;
      }
      competitorMap.set(domain, current);
    }

    for (const raw of asArray(row.serp_features)) {
      const name =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object"
            ? String(
                (raw as Record<string, unknown>).type ||
                  (raw as Record<string, unknown>).name ||
                  "SERP feature",
              )
            : "";
      if (!name) continue;
      featureMap.set(name, (featureMap.get(name) || 0) + 1);
    }
  }

  const competitors = Array.from(competitorMap.entries())
    .map(([domain, item]) => ({
      domain,
      appearances: item.appearances,
      avgRank: item.rankCount ? item.rankSum / item.rankCount : 0,
    }))
    .sort(
      (a, b) =>
        b.appearances - a.appearances || a.avgRank - b.avgRank,
    )
    .slice(0, 50);

  const serpFeatures = Array.from(featureMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const groupCounts = new Map<string, number>();
  for (const member of groupMembers || []) {
    groupCounts.set(member.group_id, (groupCounts.get(member.group_id) || 0) + 1);
  }

  const groups = (keywordGroups || []).map((group) => ({
    id: group.id,
    name: group.name,
    source: group.source,
    metric: group.metric,
    windowDays: Number(group.window_days || 28),
    keywordLimit: Number(group.keyword_limit || 20),
    count: groupCounts.get(group.id) || 0,
    lastStatus: group.last_status || "idle",
    lastDataDate: group.last_data_date,
    autoRefreshEnabled: Boolean(group.auto_refresh_enabled),
    refreshCadence: group.refresh_cadence || "daily",
  }));

  const tagCounts = new Map<string, number>();
  for (const member of tagMembers || []) {
    tagCounts.set(member.tag_id, (tagCounts.get(member.tag_id) || 0) + 1);
  }

  const tags = (manualTags || []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color_key || "purple",
    count: tagCounts.get(tag.id) || 0,
  }));

  const monthSpend = (usage || []).reduce(
    (sum, item) =>
      sum + Number(item.actual_cost ?? item.estimated_cost ?? 0),
    0,
  );

  const dataForSeoReady = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );

  const actions = {
    runRankCheck: runRankCheckFromForm.bind(null, id),
    saveSettings: saveRankTrackingSettings.bind(null, id),
    addKeywords: addTrackedKeywords.bind(null, id),
    seedFromGsc: seedFromGsc.bind(null, id),
    createTag: createRankTag.bind(null, id),
    assignTag: assignRankTag.bind(null, id),
    deleteTag: deleteRankTag.bind(null, id),
  };

  return (
    <div className="page rankTrackerPage">
      <ProjectDataNav projectId={id} active="rank" />

      {scalar(query.error) ? (
        <p className="formMessage formError pageMessage">
          {scalar(query.error)}
        </p>
      ) : null}
      {scalar(query.message) ? (
        <p className="formMessage formSuccess pageMessage">
          {scalar(query.message)}
        </p>
      ) : null}

      <RankTrackerWorkspace
        project={{
          id: project.id,
          name: project.name,
          domain: project.domain,
        }}
        locale={locale === "tr" ? "tr" : "en"}
        dataForSeoReady={dataForSeoReady}
        settings={{
          active: Boolean(config.active),
          auto_discover_enabled: Boolean(config.auto_discover_enabled),
          auto_findings_enabled: Boolean(config.auto_findings_enabled),
          max_auto_keywords: Number(config.max_auto_keywords || 100),
          min_impressions_28d: Number(config.min_impressions_28d || 100),
          position_min: Number(config.position_min || 1),
          position_max: Number(config.position_max || 30),
          default_location_code: Number(config.default_location_code || 2840),
          default_language_code: config.default_language_code || "en",
          default_device: config.default_device || "desktop",
          daily_high_priority_limit: Number(
            config.daily_high_priority_limit || 20,
          ),
          last_seeded_at: config.last_seeded_at,
          last_worker_run_at: config.last_worker_run_at,
        }}
        keywords={shapedKeywords}
        trend={trend}
        groups={groups}
        tags={tags}
        landingPages={landingPages}
        competitors={competitors}
        serpFeatures={serpFeatures}
        monthSpend={monthSpend}
        gscLastDate={gscState?.last_complete_date || null}
        gscStatus={gscState?.status || null}
        actions={actions}
      />
    </div>
  );
}
