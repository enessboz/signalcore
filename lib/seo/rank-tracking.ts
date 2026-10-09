import type { SupabaseClient } from "@supabase/supabase-js";
import { assertBudgetAvailable, logUsage } from "@/lib/costs/budget";
import { fetchGoogleOrganicSerp } from "@/lib/seo/dataforseo";
import { createClient } from "@/lib/supabase/server";

export type TrackedKeywordRow = {
  id: string;
  project_id: string;
  owner_id: string;
  keyword: string;
  target_url: string | null;
  source: "manual" | "gsc_auto" | "gsc_group" | "agent";
  priority: "high" | "normal" | "low";
  cadence: "daily" | "weekly" | "monthly";
  depth: number;
  location_code: number;
  language_code: string;
  device: "desktop" | "mobile";
  active: boolean;
  last_checked_at: string | null;
  last_position: number | null;
  last_ranking_url: string | null;
  last_status: string;
  last_error: string | null;
  consecutive_failures: number;
};

type GscCandidate = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  opportunity_score?: number;
};

function normalizedHost(value: string | null | undefined) {
  if (!value) return "";
  try {
    const raw = value.includes("://") ? value : "https://" + value;
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }
}

function domainMatches(resultDomain: string | null, projectDomain: string) {
  const result = normalizedHost(resultDomain);
  const project = normalizedHost(projectDomain);
  if (!result || !project) return false;
  return result === project || result.endsWith("." + project) || project.endsWith("." + result);
}

export function isTrackedKeywordDue(
  row: Pick<TrackedKeywordRow, "active" | "cadence" | "last_checked_at">,
  now = new Date(),
) {
  if (!row.active) return false;
  if (!row.last_checked_at) return true;

  const last = new Date(row.last_checked_at).getTime();
  const age = now.getTime() - last;
  const interval =
    row.cadence === "daily"
      ? 24 * 3600_000
      : row.cadence === "weekly"
        ? 7 * 24 * 3600_000
        : 30 * 24 * 3600_000;

  return age >= interval;
}

function changeImportance(previous: number | null, current: number | null) {
  if (previous === null && current !== null && current <= 10) return "medium" as const;
  if (previous !== null && current === null && previous <= 20) return "high" as const;
  if (previous !== null && current !== null) {
    const drop = current - previous;
    if (previous <= 10 && drop >= 5) return "high" as const;
    if (previous <= 20 && drop >= 5) return "medium" as const;
  }
  return "low" as const;
}

async function writeRankFinding(input: {
  supabase: SupabaseClient;
  keyword: TrackedKeywordRow;
  previousPosition: number | null;
  previousUrl: string | null;
  currentPosition: number | null;
  currentUrl: string | null;
}) {
  const { keyword, previousPosition, previousUrl, currentPosition, currentUrl } = input;
  const now = new Date().toISOString();
  const findings: Array<Record<string, unknown>> = [];

  if (
    previousPosition !== null &&
    currentPosition !== null &&
    currentPosition - previousPosition >= 5 &&
    previousPosition <= 30
  ) {
    findings.push({
      project_id: keyword.project_id,
      owner_id: keyword.owner_id,
      finding_type: "regression",
      title: "Ranking drop: " + keyword.keyword,
      summary:
        keyword.keyword +
        " moved from position " +
        previousPosition +
        " to " +
        currentPosition +
        " in the configured SERP snapshot.",
      why_it_matters:
        "A material exact-rank decline can confirm that a GSC visibility change is not only an averaging effect.",
      importance: changeImportance(previousPosition, currentPosition),
      confidence: "high",
      fingerprint: "rank:drop:" + keyword.id,
      affected_scope: {
        keyword: keyword.keyword,
        previous_position: previousPosition,
        current_position: currentPosition,
        ranking_url: currentUrl,
      },
      recommended_action:
        "Compare the current SERP, ranking URL, recent technical/content changes and GSC query trend before choosing a fix.",
      metadata: {
        source: "rank_tracker",
        detector: "rank_tracking_v1",
        tracked_keyword_id: keyword.id,
        previous_position: previousPosition,
        current_position: currentPosition,
      },
      last_seen_at: now,
      updated_at: now,
    });
  }

  if (previousPosition !== null && previousPosition <= 30 && currentPosition === null) {
    findings.push({
      project_id: keyword.project_id,
      owner_id: keyword.owner_id,
      finding_type: "regression",
      title: "Tracked keyword left monitored SERP depth: " + keyword.keyword,
      summary:
        keyword.keyword +
        " was previously at position " +
        previousPosition +
        " but the project domain was not found in the current monitored depth.",
      why_it_matters:
        "Losing a previously visible exact SERP position is a stronger regression signal when confirmed alongside GSC or technical evidence.",
      importance: previousPosition <= 10 ? "high" : "medium",
      confidence: "high",
      fingerprint: "rank:lost:" + keyword.id,
      affected_scope: {
        keyword: keyword.keyword,
        previous_position: previousPosition,
        current_position: null,
      },
      recommended_action:
        "Check indexability, canonical state, ranking URL ownership, current competitors and GSC visibility before remediation.",
      metadata: {
        source: "rank_tracker",
        detector: "rank_tracking_v1",
        tracked_keyword_id: keyword.id,
      },
      last_seen_at: now,
      updated_at: now,
    });
  }

  if (
    previousPosition !== null &&
    currentPosition !== null &&
    previousUrl &&
    currentUrl &&
    previousUrl !== currentUrl
  ) {
    findings.push({
      project_id: keyword.project_id,
      owner_id: keyword.owner_id,
      finding_type: "observation",
      title: "Ranking URL changed: " + keyword.keyword,
      summary:
        "The ranking URL for " +
        keyword.keyword +
        " changed from " +
        previousUrl +
        " to " +
        currentUrl +
        ".",
      why_it_matters:
        "A ranking URL switch can reflect healthy intent ownership, URL replacement or potential internal competition and should be interpreted with GSC/query context.",
      importance: "medium",
      confidence: "high",
      fingerprint: "rank:url-switch:" + keyword.id,
      affected_scope: {
        keyword: keyword.keyword,
        previous_url: previousUrl,
        current_url: currentUrl,
        current_position: currentPosition,
      },
      recommended_action:
        "Compare both URLs' intent, internal links, canonical state and GSC query ownership before deciding whether consolidation is needed.",
      metadata: {
        source: "rank_tracker",
        detector: "rank_tracking_v1",
        tracked_keyword_id: keyword.id,
      },
      last_seen_at: now,
      updated_at: now,
    });
  }

  if (
    (previousPosition === null || previousPosition > 10) &&
    currentPosition !== null &&
    currentPosition <= 10
  ) {
    findings.push({
      project_id: keyword.project_id,
      owner_id: keyword.owner_id,
      finding_type: "opportunity",
      title: "Tracked keyword entered top 10: " + keyword.keyword,
      summary:
        keyword.keyword +
        " is now at exact monitored position " +
        currentPosition +
        ".",
      why_it_matters:
        "A newly achieved first-page position can be a useful moment to reinforce the ranking URL and improve click capture.",
      importance: currentPosition <= 3 ? "high" : "medium",
      confidence: "high",
      fingerprint: "rank:top10:" + keyword.id,
      affected_scope: {
        keyword: keyword.keyword,
        current_position: currentPosition,
        ranking_url: currentUrl,
      },
      recommended_action:
        "Validate GSC impressions/CTR and the current SERP, then strengthen the ranking page only if the query is commercially relevant.",
      metadata: {
        source: "rank_tracker",
        detector: "rank_tracking_v1",
        tracked_keyword_id: keyword.id,
      },
      last_seen_at: now,
      updated_at: now,
    });
  }

  if (findings.length) {
    const fingerprints = findings.map((item) => String(item.fingerprint));
    const { data: existingFindings, error: existingError } = await input.supabase
      .from("findings")
      .select("fingerprint,status")
      .eq("project_id", keyword.project_id)
      .eq("owner_id", keyword.owner_id)
      .in("fingerprint", fingerprints);

    if (existingError) {
      throw new Error("Existing rank finding status lookup failed: " + existingError.message);
    }

    const statusByFingerprint = new Map(
      (existingFindings || []).map((item) => [item.fingerprint, item.status]),
    );

    const { error } = await input.supabase.from("findings").upsert(
      findings.map((item) => ({
        ...item,
        status: statusByFingerprint.get(String(item.fingerprint)) || "open",
      })),
      {
        onConflict: "project_id,fingerprint",
      },
    );
    if (error) throw new Error("Rank findings could not be saved: " + error.message);
  }
}

export async function seedTrackedKeywordsFromGsc(input: {
  ownerId: string;
  projectId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: settings } = await supabase
    .from("rank_tracking_settings")
    .select("*")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .maybeSingle();

  const config = settings || {
    max_auto_keywords: 100,
    min_impressions_28d: 100,
    position_min: 1,
    position_max: 30,
    default_location_code: 2840,
    default_language_code: "en",
    default_device: "desktop",
    daily_high_priority_limit: 20,
  };

  const { data, error } = await supabase.rpc("get_gsc_tracking_candidates", {
    p_project_id: input.projectId,
    p_days: 28,
    p_min_impressions: config.min_impressions_28d,
    p_position_min: config.position_min,
    p_position_max: config.position_max,
    p_limit: config.max_auto_keywords,
  });

  if (error) throw new Error("GSC tracking candidates failed: " + error.message);

  const payload = (data || {}) as {
    available?: boolean;
    current_end?: string | null;
    candidates?: GscCandidate[];
  };
  const candidates = payload.candidates || [];

  if (!candidates.length) {
    await supabase.from("rank_tracking_settings").upsert(
      {
        project_id: input.projectId,
        owner_id: input.ownerId,
        last_seeded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id" },
    );
    return { inserted: 0, candidates: 0, dataDate: payload.current_end || null };
  }

  const sorted = [...candidates].sort(
    (a, b) =>
      Number(b.opportunity_score || b.impressions) -
      Number(a.opportunity_score || a.impressions),
  );
  const dailyLimit = Number(config.daily_high_priority_limit || 20);

  const rows = sorted.map((candidate, index) => ({
    project_id: input.projectId,
    owner_id: input.ownerId,
    keyword: candidate.query,
    source: "gsc_auto",
    priority: index < dailyLimit ? "high" : "normal",
    cadence: index < dailyLimit ? "daily" : "weekly",
    depth: index < dailyLimit ? 30 : 30,
    location_code: config.default_location_code,
    language_code: config.default_language_code,
    device: config.default_device,
    active: true,
    updated_at: new Date().toISOString(),
  }));

  const { data: existing } = await supabase
    .from("tracked_keywords")
    .select("keyword,location_code,language_code,device")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId);

  const existingKeys = new Set(
    (existing || []).map(
      (row) =>
        row.keyword.trim().toLowerCase() +
        "|" +
        row.location_code +
        "|" +
        row.language_code +
        "|" +
        row.device,
    ),
  );

  const newRows = rows.filter(
    (row) =>
      !existingKeys.has(
        row.keyword.trim().toLowerCase() +
          "|" +
          row.location_code +
          "|" +
          row.language_code +
          "|" +
          row.device,
      ),
  );

  if (newRows.length) {
    const { error: insertError } = await supabase
      .from("tracked_keywords")
      .insert(newRows);
    if (insertError) {
      throw new Error("Tracked keyword seed failed: " + insertError.message);
    }
  }

  await supabase.from("rank_tracking_settings").upsert(
    {
      project_id: input.projectId,
      owner_id: input.ownerId,
      last_seeded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  return {
    inserted: newRows.length,
    candidates: candidates.length,
    dataDate: payload.current_end || null,
  };
}

export async function checkTrackedKeyword(input: {
  keyword: TrackedKeywordRow;
  projectDomain: string;
  autoFindings?: boolean;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const keyword = input.keyword;

  const { data: previousHistory } = await supabase
    .from("rank_history")
    .select("position,ranking_url,checked_at")
    .eq("tracked_keyword_id", keyword.id)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const conservativeRequestEstimate = Math.max(
    Number(process.env.SERP_ESTIMATED_COST_PER_REQUEST_USD || "0.01"),
    0,
  );

  try {
    await assertBudgetAvailable({
      ownerId: keyword.owner_id,
      projectId: keyword.project_id,
      category: "serp",
      estimatedNextCost: conservativeRequestEstimate,
      client: supabase,
    });

    const result = await fetchGoogleOrganicSerp({
      keyword: keyword.keyword,
      locationCode: keyword.location_code,
      languageCode: keyword.language_code,
      device: keyword.device,
      depth: keyword.depth,
    });

    const match = result.organic.find((item) =>
      domainMatches(item.domain, input.projectDomain),
    );

    const position = match?.rank ? Number(match.rank) : null;
    const rankingUrl = match?.url || null;
    const rankingTitle = match?.title || null;
    const matchedDomain = match?.domain || null;
    const competitors = result.organic
      .filter((item) => !domainMatches(item.domain, input.projectDomain))
      .slice(0, 10)
      .map((item) => ({
        rank: item.rank,
        domain: item.domain,
        url: item.url,
        title: item.title,
      }));

    const { data: serpCheck, error: serpError } = await supabase
      .from("serp_checks")
      .insert({
        project_id: keyword.project_id,
        owner_id: keyword.owner_id,
        provider: "dataforseo",
        engine: "google",
        search_type: "organic",
        keyword: keyword.keyword,
        location_code: keyword.location_code,
        language_code: keyword.language_code,
        status: "succeeded",
        result: {
          check_url: result.check_url,
          organic: result.organic,
          serp_features: result.serp_features,
          device: keyword.device,
          depth: keyword.depth,
          tracked_keyword_id: keyword.id,
        },
        estimated_cost: result.cost,
      })
      .select("id")
      .single();

    if (serpError || !serpCheck) {
      throw new Error(serpError?.message || "SERP check could not be saved.");
    }

    const checkedAt = new Date().toISOString();
    const { error: historyError } = await supabase.from("rank_history").insert({
      tracked_keyword_id: keyword.id,
      project_id: keyword.project_id,
      owner_id: keyword.owner_id,
      checked_at: checkedAt,
      provider: "dataforseo",
      position,
      ranking_url: rankingUrl,
      ranking_title: rankingTitle,
      matched_domain: matchedDomain,
      organic_result_count: result.organic.length,
      serp_features: result.serp_features,
      top_competitors: competitors,
      cost: result.cost,
      metadata: {
        serp_check_id: serpCheck.id,
        device: keyword.device,
        depth: keyword.depth,
        location_code: keyword.location_code,
        language_code: keyword.language_code,
      },
    });

    if (historyError) throw new Error("Rank history failed: " + historyError.message);

    const { error: keywordError } = await supabase
      .from("tracked_keywords")
      .update({
        last_checked_at: checkedAt,
        last_position: position,
        last_ranking_url: rankingUrl,
        last_status: "succeeded",
        last_error: null,
        consecutive_failures: 0,
        updated_at: checkedAt,
      })
      .eq("id", keyword.id)
      .eq("owner_id", keyword.owner_id);

    if (keywordError) throw new Error(keywordError.message);

    await logUsage({
      ownerId: keyword.owner_id,
      projectId: keyword.project_id,
      category: "serp",
      provider: "dataforseo",
      units: 1,
      estimatedCost: conservativeRequestEstimate,
      actualCost: result.cost,
      metadata: {
        tracked_keyword_id: keyword.id,
        keyword: keyword.keyword,
        location_code: keyword.location_code,
        language_code: keyword.language_code,
        device: keyword.device,
        depth: keyword.depth,
        search_type: "rank_tracking",
      },
      client: supabase,
    });

    if (input.autoFindings !== false) {
      await writeRankFinding({
        supabase,
        keyword,
        previousPosition:
          previousHistory?.position === null || previousHistory?.position === undefined
            ? null
            : Number(previousHistory.position),
        previousUrl: previousHistory?.ranking_url || null,
        currentPosition: position,
        currentUrl: rankingUrl,
      });
    }

    return {
      success: true as const,
      keywordId: keyword.id,
      keyword: keyword.keyword,
      position,
      rankingUrl,
      previousPosition:
        previousHistory?.position === null || previousHistory?.position === undefined
          ? null
          : Number(previousHistory.position),
      cost: result.cost,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Rank tracking request failed.";
    const budgetBlocked = /budget hard-stop reached/i.test(message);
    const failureCount = Number(keyword.consecutive_failures || 0) + 1;

    await supabase
      .from("tracked_keywords")
      .update({
        ...(budgetBlocked ? {} : { last_checked_at: new Date().toISOString() }),
        last_status: budgetBlocked ? "paused" : "failed",
        last_error: message,
        consecutive_failures: budgetBlocked
          ? Number(keyword.consecutive_failures || 0)
          : failureCount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", keyword.id)
      .eq("owner_id", keyword.owner_id);

    return {
      success: false as const,
      keywordId: keyword.id,
      keyword: keyword.keyword,
      position: null,
      rankingUrl: null,
      previousPosition: null,
      cost: 0,
      error: message,
      budgetBlocked,
    };
  }
}

export async function runRankTrackingBatch(input: {
  ownerId: string;
  projectId: string;
  keywordIds?: string[];
  triggerType?: "cron" | "manual" | "chief" | "agent";
  limit?: number;
  onlyDue?: boolean;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);

  const [{ data: project, error: projectError }, { data: settings }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id,domain")
        .eq("id", input.projectId)
        .eq("owner_id", input.ownerId)
        .single(),
      supabase
        .from("rank_tracking_settings")
        .select("auto_findings_enabled")
        .eq("project_id", input.projectId)
        .eq("owner_id", input.ownerId)
        .maybeSingle(),
    ]);

  if (projectError || !project?.domain) {
    throw new Error(projectError?.message || "Project domain is required.");
  }

  let query = supabase
    .from("tracked_keywords")
    .select("*")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(Math.max(limit * 4, limit));

  if (input.keywordIds?.length) {
    query = query.in("id", input.keywordIds);
  }

  const { data: keywordRows, error: keywordError } = await query;
  if (keywordError) throw new Error(keywordError.message);

  let rows = (keywordRows || []) as TrackedKeywordRow[];
  if (input.onlyDue !== false && !input.keywordIds?.length) {
    rows = rows.filter((row) => isTrackedKeywordDue(row));
  }

  rows = rows
    .sort((a, b) => {
      const weight = { high: 0, normal: 1, low: 2 };
      const priorityDelta = weight[a.priority] - weight[b.priority];
      if (priorityDelta) return priorityDelta;
      const aTime = a.last_checked_at ? new Date(a.last_checked_at).getTime() : 0;
      const bTime = b.last_checked_at ? new Date(b.last_checked_at).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, limit);

  if (!rows.length) {
    return {
      runId: null,
      requested: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      actualCost: 0,
      results: [],
    };
  }

  const { data: run, error: runError } = await supabase
    .from("rank_tracking_runs")
    .insert({
      project_id: input.projectId,
      owner_id: input.ownerId,
      trigger_type: input.triggerType || "manual",
      status: "running",
      keywords_requested: rows.length,
    })
    .select("id")
    .single();

  if (runError || !run) {
    throw new Error(runError?.message || "Rank tracking run could not be created.");
  }

  const results = [];
  for (const row of rows) {
    const result = await checkTrackedKeyword({
      keyword: row,
      projectDomain: project.domain,
      autoFindings: settings?.auto_findings_enabled !== false,
      client: supabase,
    });
    results.push(result);
    if ("budgetBlocked" in result && result.budgetBlocked) break;
  }

  const succeeded = results.filter((item) => item.success).length;
  const failed = results.length - succeeded;
  const actualCost = results.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const status = failed === 0 ? "succeeded" : succeeded ? "partial" : "failed";

  await supabase
    .from("rank_tracking_runs")
    .update({
      status,
      keywords_completed: results.length,
      succeeded,
      failed,
      actual_cost: actualCost,
      result: {
        keyword_ids: rows.map((row) => row.id),
        top_changes: results
          .filter((item) => item.success)
          .map((item) => ({
            keyword: item.keyword,
            previous_position: item.previousPosition,
            current_position: item.position,
            ranking_url: item.rankingUrl,
          }))
          .slice(0, 25),
      },
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  await supabase.from("rank_tracking_settings").upsert(
    {
      project_id: input.projectId,
      owner_id: input.ownerId,
      last_worker_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  return {
    runId: run.id as string,
    requested: rows.length,
    completed: results.length,
    succeeded,
    failed,
    actualCost,
    results,
  };
}
