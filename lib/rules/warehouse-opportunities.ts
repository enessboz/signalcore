import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

type Importance = "critical" | "high" | "medium" | "low";
type FindingType = "opportunity" | "regression" | "strategy_discovery" | "observation";

type QueryComparison = {
  query: string;
  current_clicks: number;
  previous_clicks: number;
  current_impressions: number;
  previous_impressions: number;
  current_ctr: number;
  previous_ctr: number;
  current_position: number;
  previous_position: number;
};

type PageComparison = {
  page: string;
  current_clicks: number;
  previous_clicks: number;
  current_impressions: number;
  previous_impressions: number;
  current_ctr: number;
  previous_ctr: number;
  current_position: number;
  previous_position: number;
};

type GscOpportunityPayload = {
  available?: boolean;
  period?: Record<string, string | null>;
  queries?: QueryComparison[];
  pages?: PageComparison[];
};

type Candidate = {
  findingType: FindingType;
  fingerprint: string;
  title: string;
  summary: string;
  whyItMatters: string;
  importance: Importance;
  confidence: "high" | "medium";
  recommendedAction: string;
  affectedScope: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function number(value: unknown) {
  return Number(value || 0);
}

function pctChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 1 : 0;
  return (current - previous) / previous;
}

function importanceFromVolume(impressions: number, clicks = 0): Importance {
  if (impressions >= 5000 || clicks >= 100) return "high";
  if (impressions >= 500 || clicks >= 20) return "medium";
  return "low";
}

function normalizeUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

function addGscQueryCandidates(
  rows: QueryComparison[],
  candidates: Candidate[],
) {
  for (const row of rows) {
    const currentImpressions = number(row.current_impressions);
    const previousImpressions = number(row.previous_impressions);
    const currentClicks = number(row.current_clicks);
    const previousClicks = number(row.previous_clicks);
    const currentCtr = number(row.current_ctr);
    const currentPosition = number(row.current_position);
    const previousPosition = number(row.previous_position);
    const query = row.query;

    if (
      currentImpressions >= 100 &&
      currentPosition >= 5 &&
      currentPosition <= 20
    ) {
      candidates.push({
        findingType: "opportunity",
        fingerprint: "gscw:striking-distance:" + query,
        title: "Striking-distance query: " + query,
        summary:
          currentImpressions.toLocaleString() +
          " impressions at average position " +
          currentPosition.toFixed(1) +
          " in the latest warehouse period.",
        whyItMatters:
          "The query already has meaningful first-party visibility and is close enough to stronger first-page positions to justify focused review.",
        importance: importanceFromVolume(currentImpressions, currentClicks),
        confidence: "high",
        recommendedAction:
          "Review ranking URL intent match, current SERP, title/H1, content coverage and internal links before selecting an optimization.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "striking_distance",
          current: row,
        },
      });
    }

    if (
      currentImpressions >= 200 &&
      currentPosition > 0 &&
      currentPosition <= 10 &&
      currentCtr < 0.02
    ) {
      candidates.push({
        findingType: "opportunity",
        fingerprint: "gscw:low-ctr:" + query,
        title: "Visible query with low CTR: " + query,
        summary:
          currentImpressions.toLocaleString() +
          " impressions, " +
          (currentCtr * 100).toFixed(2) +
          "% CTR and average position " +
          currentPosition.toFixed(1) +
          ".",
        whyItMatters:
          "The query already earns page-one visibility but captures relatively few clicks from those impressions.",
        importance: importanceFromVolume(currentImpressions, currentClicks),
        confidence: "high",
        recommendedAction:
          "Inspect the live SERP, title/meta proposition, intent match and rich-result opportunities before changing the snippet.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "high_impression_low_ctr",
          current: row,
        },
      });
    }

    const impressionChange = pctChange(currentImpressions, previousImpressions);
    if (
      currentImpressions >= 200 &&
      previousImpressions >= 20 &&
      impressionChange >= 0.5
    ) {
      candidates.push({
        findingType: "strategy_discovery",
        fingerprint: "gscw:rising-query:" + query,
        title: "Rising search demand/visibility: " + query,
        summary:
          "Impressions increased " +
          (impressionChange * 100).toFixed(0) +
          "% versus the previous comparison period.",
        whyItMatters:
          "Growing visibility can reveal emerging relevance or demand worth reinforcing before it becomes obvious in aggregate traffic.",
        importance: importanceFromVolume(currentImpressions, currentClicks),
        confidence: "high",
        recommendedAction:
          "Validate search intent and ranking URL ownership, then decide whether existing content should be reinforced or a dedicated asset is justified.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "rising_query",
          current: row,
          impression_change: impressionChange,
        },
      });
    }

    const clickChange = pctChange(currentClicks, previousClicks);
    if (previousClicks >= 10 && clickChange <= -0.3) {
      candidates.push({
        findingType: "regression",
        fingerprint: "gscw:declining-query:" + query,
        title: "Organic query decline: " + query,
        summary:
          "Clicks decreased " +
          Math.abs(clickChange * 100).toFixed(0) +
          "% versus the previous warehouse period.",
        whyItMatters:
          "A query with previously meaningful organic traffic is losing clicks and should be checked for ranking, CTR, intent or SERP changes.",
        importance: importanceFromVolume(previousImpressions, previousClicks),
        confidence: "high",
        recommendedAction:
          "Compare exact rank, position, impressions and CTR changes, then inspect the ranking URL and current SERP before choosing a fix.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "declining_query",
          current: row,
          click_change: clickChange,
        },
      });
    }

    if (
      previousImpressions >= 100 &&
      currentImpressions < previousImpressions * 0.2
    ) {
      candidates.push({
        findingType: "regression",
        fingerprint: "gscw:lost-query:" + query,
        title: "Lost search visibility: " + query,
        summary:
          "A query with " +
          previousImpressions.toLocaleString() +
          " previous-period impressions has lost most of its visibility.",
        whyItMatters:
          "A large visibility loss can indicate ranking displacement, changed intent, technical issues or content decay.",
        importance: importanceFromVolume(previousImpressions, previousClicks),
        confidence: "high",
        recommendedAction:
          "Check exact rank history, indexability/canonical state, the previous ranking URL and current SERP competitors.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "lost_query",
          current: row,
        },
      });
    }

    if (currentImpressions >= 100 && previousImpressions === 0) {
      candidates.push({
        findingType: "strategy_discovery",
        fingerprint: "gscw:new-query:" + query,
        title: "New organic visibility: " + query,
        summary:
          query +
          " generated " +
          currentImpressions.toLocaleString() +
          " impressions in the current period with no prior-period visibility in the warehouse comparison.",
        whyItMatters:
          "New visibility can reveal an emerging intent, topic or ranking asset before it becomes material traffic.",
        importance: importanceFromVolume(currentImpressions, currentClicks),
        confidence: "high",
        recommendedAction:
          "Confirm the ranking page and search intent, then decide whether to reinforce existing coverage or monitor before acting.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "new_query",
          current: row,
        },
      });
    }

    if (
      previousPosition > 0 &&
      previousPosition <= 20 &&
      currentPosition - previousPosition >= 5 &&
      currentImpressions >= 100
    ) {
      candidates.push({
        findingType: "regression",
        fingerprint: "gscw:position-drop:" + query,
        title: "Average position deterioration: " + query,
        summary:
          "GSC average position moved from " +
          previousPosition.toFixed(1) +
          " to " +
          currentPosition.toFixed(1) +
          " while the query still generated meaningful impressions.",
        whyItMatters:
          "A material position deterioration can explain traffic loss, but GSC is an average across contexts and should be validated with exact rank/URL evidence.",
        importance: importanceFromVolume(currentImpressions, currentClicks),
        confidence: "medium",
        recommendedAction:
          "Cross-check the exact configured rank tracker and ranking URL before treating the GSC average as a confirmed ranking loss.",
        affectedScope: { query },
        metadata: {
          source: "gsc_warehouse",
          rule: "position_drop",
          current: row,
        },
      });
    }
  }
}

function addGscPageCandidates(
  rows: PageComparison[],
  candidates: Candidate[],
) {
  for (const row of rows) {
    const currentClicks = number(row.current_clicks);
    const previousClicks = number(row.previous_clicks);
    const currentImpressions = number(row.current_impressions);
    const previousImpressions = number(row.previous_impressions);
    const clickChange = pctChange(currentClicks, previousClicks);

    if (previousClicks >= 20 && clickChange <= -0.3) {
      candidates.push({
        findingType: "regression",
        fingerprint: "gscw:declining-page:" + row.page,
        title: "Declining organic landing page",
        summary:
          row.page +
          " lost " +
          Math.abs(clickChange * 100).toFixed(0) +
          "% of clicks versus the previous warehouse period.",
        whyItMatters:
          "Page-level declines can aggregate multiple query losses and deserve a focused technical, intent and content review.",
        importance: importanceFromVolume(previousImpressions, previousClicks),
        confidence: "high",
        recommendedAction:
          "Break the page down by queries, compare exact rank/CTR changes and inspect technical state before deciding remediation.",
        affectedScope: { page: row.page },
        metadata: {
          source: "gsc_warehouse",
          rule: "declining_page",
          current: row,
        },
      });
    }

    const clickGrowth = pctChange(currentClicks, previousClicks);
    if (
      currentClicks >= 20 &&
      previousClicks >= 5 &&
      clickGrowth >= 0.5 &&
      currentImpressions >= 200
    ) {
      candidates.push({
        findingType: "strategy_discovery",
        fingerprint: "gscw:rising-page:" + row.page,
        title: "Organic landing page gaining traction",
        summary:
          row.page +
          " increased clicks " +
          (clickGrowth * 100).toFixed(0) +
          "% versus the previous period.",
        whyItMatters:
          "A page gaining meaningful organic traction can reveal content or intent patterns worth reinforcing across the site.",
        importance: importanceFromVolume(currentImpressions, currentClicks),
        confidence: "high",
        recommendedAction:
          "Review the queries and internal-link context behind the growth before replicating or expanding the pattern.",
        affectedScope: { page: row.page },
        metadata: {
          source: "gsc_warehouse",
          rule: "rising_page",
          current: row,
        },
      });
    }
  }
}

function addGa4Candidates(
  summary: Record<string, unknown> | null,
  candidates: Candidate[],
) {
  if (!summary) return;

  const declining = Array.isArray(summary.declining_organic_landing_pages)
    ? (summary.declining_organic_landing_pages as Array<Record<string, unknown>>)
    : [];
  const rising = Array.isArray(summary.rising_organic_landing_pages)
    ? (summary.rising_organic_landing_pages as Array<Record<string, unknown>>)
    : [];

  for (const row of declining) {
    const current = number(row.current_sessions);
    const previous = number(row.previous_sessions);
    if (previous < 20) continue;
    const change = pctChange(current, previous);
    if (change > -0.3) continue;
    const page = String(row.landing_page || "");
    if (!page) continue;

    candidates.push({
      findingType: "regression",
      fingerprint: "ga4w:organic-session-decline:" + page,
      title: "Organic landing page session decline",
      summary:
        page +
        " lost " +
        Math.abs(change * 100).toFixed(0) +
        "% of organic sessions versus the previous GA4 period.",
      whyItMatters:
        "A material organic session decline can confirm that a search visibility issue is affecting real site traffic, not only SERP metrics.",
      importance: previous >= 500 ? "high" : previous >= 100 ? "medium" : "low",
      confidence: "high",
      recommendedAction:
        "Cross-check the page in GSC and rank history, then review technical changes and query-level losses before remediation.",
      affectedScope: { landing_page: page },
      metadata: {
        source: "ga4_warehouse",
        rule: "organic_session_decline",
        current_sessions: current,
        previous_sessions: previous,
        session_change: change,
      },
    });
  }

  for (const row of rising) {
    const current = number(row.current_sessions);
    const previous = number(row.previous_sessions);
    if (current < 30 || previous < 5) continue;
    const change = pctChange(current, previous);
    if (change < 0.5) continue;
    const page = String(row.landing_page || "");
    if (!page) continue;

    candidates.push({
      findingType: "strategy_discovery",
      fingerprint: "ga4w:organic-session-growth:" + page,
      title: "Organic landing page growth",
      summary:
        page +
        " increased organic sessions " +
        (change * 100).toFixed(0) +
        "% versus the previous GA4 period.",
      whyItMatters:
        "Sustained organic traffic growth can reveal winning content, intent and internal-link patterns worth understanding before scaling.",
      importance: current >= 500 ? "high" : current >= 100 ? "medium" : "low",
      confidence: "high",
      recommendedAction:
        "Identify which queries and page changes contributed to the growth, then decide whether the pattern can be applied elsewhere.",
      affectedScope: { landing_page: page },
      metadata: {
        source: "ga4_warehouse",
        rule: "organic_session_growth",
        current_sessions: current,
        previous_sessions: previous,
        session_change: change,
      },
    });
  }
}

async function addRankCrossSourceCandidates(input: {
  supabase: SupabaseClient;
  ownerId: string;
  projectId: string;
  queryRows: QueryComparison[];
  candidates: Candidate[];
}) {
  const { data: keywords, error } = await input.supabase
    .from("tracked_keywords")
    .select("id,keyword,target_url,last_position,last_ranking_url,last_checked_at,active")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .eq("active", true)
    .limit(1000);

  if (error) throw new Error("Tracked keyword lookup failed: " + error.message);

  const queryMap = new Map(
    input.queryRows.map((row) => [row.query.trim().toLowerCase(), row]),
  );

  for (const tracked of keywords || []) {
    if (tracked.last_position === null || !tracked.last_checked_at) continue;
    const gsc = queryMap.get(tracked.keyword.trim().toLowerCase());
    if (!gsc) continue;

    const impressions = number(gsc.current_impressions);
    const ctr = number(gsc.current_ctr);
    const exactPosition = Number(tracked.last_position);

    if (impressions >= 100 && exactPosition >= 4 && exactPosition <= 20) {
      input.candidates.push({
        findingType: "opportunity",
        fingerprint: "cross:confirmed-striking:" + tracked.id,
        title: "GSC + exact rank opportunity: " + tracked.keyword,
        summary:
          tracked.keyword +
          " has " +
          impressions.toLocaleString() +
          " GSC impressions and exact monitored rank #" +
          exactPosition +
          ".",
        whyItMatters:
          "Two independent signals confirm both demand and a reachable exact SERP position, increasing confidence that focused optimization may be worthwhile.",
        importance: importanceFromVolume(impressions, number(gsc.current_clicks)),
        confidence: "high",
        recommendedAction:
          "Review the exact SERP and ranking URL against intent, competitors, internal links and page coverage before implementing changes.",
        affectedScope: {
          query: tracked.keyword,
          exact_position: exactPosition,
          ranking_url: tracked.last_ranking_url,
        },
        metadata: {
          source: "cross_source",
          rule: "gsc_exact_rank_striking_distance",
          tracked_keyword_id: tracked.id,
          gsc,
        },
      });
    }

    if (impressions >= 200 && exactPosition <= 10 && ctr < 0.02) {
      input.candidates.push({
        findingType: "opportunity",
        fingerprint: "cross:confirmed-low-ctr:" + tracked.id,
        title: "Exact top-10 rank with weak GSC CTR: " + tracked.keyword,
        summary:
          tracked.keyword +
          " is exact rank #" +
          exactPosition +
          " with " +
          (ctr * 100).toFixed(2) +
          "% GSC CTR.",
        whyItMatters:
          "Exact rank confirms strong visibility while first-party CTR shows that the listing is not capturing clicks proportionally.",
        importance: importanceFromVolume(impressions, number(gsc.current_clicks)),
        confidence: "high",
        recommendedAction:
          "Inspect competing snippets, title/meta proposition, SERP features and intent before changing the page snippet.",
        affectedScope: {
          query: tracked.keyword,
          exact_position: exactPosition,
          ranking_url: tracked.last_ranking_url,
        },
        metadata: {
          source: "cross_source",
          rule: "exact_rank_low_ctr",
          tracked_keyword_id: tracked.id,
          gsc,
        },
      });
    }

    if (
      tracked.target_url &&
      tracked.last_ranking_url &&
      normalizeUrl(tracked.target_url) !== normalizeUrl(tracked.last_ranking_url)
    ) {
      input.candidates.push({
        findingType: "observation",
        fingerprint: "cross:unexpected-ranking-url:" + tracked.id,
        title: "Unexpected ranking URL: " + tracked.keyword,
        summary:
          "Configured target " +
          tracked.target_url +
          " differs from the current ranking URL " +
          tracked.last_ranking_url +
          ".",
        whyItMatters:
          "The mismatch can be healthy intent ownership or indicate that the intended page is not the URL Google currently prefers.",
        importance: impressions >= 500 ? "medium" : "low",
        confidence: "high",
        recommendedAction:
          "Compare the target and ranking URLs for intent, canonical/indexability, internal links and content overlap before changing ownership.",
        affectedScope: {
          query: tracked.keyword,
          target_url: tracked.target_url,
          ranking_url: tracked.last_ranking_url,
          exact_position: exactPosition,
        },
        metadata: {
          source: "cross_source",
          rule: "unexpected_ranking_url",
          tracked_keyword_id: tracked.id,
        },
      });
    }
  }
}

export async function detectWarehouseOpportunities(input: {
  ownerId: string;
  projectId: string;
  scanGsc?: boolean;
  scanGa4?: boolean;
  scanRank?: boolean;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const candidates: Candidate[] = [];
  let gscPayload: GscOpportunityPayload | null = null;
  let ga4Payload: Record<string, unknown> | null = null;

  if (input.scanGsc !== false) {
    const { data, error } = await supabase.rpc("get_gsc_opportunity_dataset", {
      p_project_id: input.projectId,
      p_days: 28,
      p_limit: 2500,
    });
    if (error) throw new Error("GSC opportunity dataset failed: " + error.message);
    gscPayload = (data || {}) as GscOpportunityPayload;

    const queries = gscPayload?.queries || [];
    const pages = gscPayload?.pages || [];
    addGscQueryCandidates(queries, candidates);
    addGscPageCandidates(pages, candidates);
  }

  if (input.scanGa4 !== false) {
    const { data, error } = await supabase.rpc("get_ga4_agent_summary", {
      p_project_id: input.projectId,
      p_days: 28,
    });
    if (error) throw new Error("GA4 opportunity summary failed: " + error.message);
    ga4Payload = (data || {}) as Record<string, unknown>;
    addGa4Candidates(ga4Payload, candidates);
  }

  if (input.scanRank !== false && gscPayload?.queries?.length) {
    await addRankCrossSourceCandidates({
      supabase,
      ownerId: input.ownerId,
      projectId: input.projectId,
      queryRows: gscPayload.queries,
      candidates,
    });
  }

  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.fingerprint);
    const weight = { critical: 4, high: 3, medium: 2, low: 1 };
    if (
      !existing ||
      weight[candidate.importance] > weight[existing.importance]
    ) {
      unique.set(candidate.fingerprint, candidate);
    }
  }

  const ordered = [...unique.values()]
    .sort((a, b) => {
      const weight = { critical: 4, high: 3, medium: 2, low: 1 };
      return weight[b.importance] - weight[a.importance];
    })
    .slice(0, 1000);

  const now = new Date().toISOString();
  if (ordered.length) {
    const { error } = await supabase.from("findings").upsert(
      ordered.map((candidate) => ({
        project_id: input.projectId,
        owner_id: input.ownerId,
        finding_type: candidate.findingType,
        title: candidate.title,
        summary: candidate.summary,
        why_it_matters: candidate.whyItMatters,
        importance: candidate.importance,
        confidence: candidate.confidence,
        fingerprint: candidate.fingerprint,
        affected_scope: candidate.affectedScope,
        recommended_action: candidate.recommendedAction,
        metadata: {
          detector: "warehouse_opportunity_engine_v1",
          ...candidate.metadata,
        },
        last_seen_at: now,
        updated_at: now,
      })),
      {
        onConflict: "project_id,fingerprint",
      },
    );
    if (error) throw new Error("Opportunity findings could not be saved: " + error.message);
  }

  const gscDate =
    gscPayload?.period?.current_end &&
    typeof gscPayload.period.current_end === "string"
      ? gscPayload.period.current_end
      : null;
  const ga4Period = (ga4Payload?.period || {}) as Record<string, unknown>;
  const ga4Date =
    typeof ga4Period.current_end === "string" ? ga4Period.current_end : null;
  const dataDate =
    [gscDate, ga4Date].filter(Boolean).sort().slice(-1)[0] || null;

  return {
    candidates: ordered.length,
    high: ordered.filter((item) => item.importance === "high").length,
    medium: ordered.filter((item) => item.importance === "medium").length,
    low: ordered.filter((item) => item.importance === "low").length,
    dataDate,
    gscAvailable: Boolean(gscPayload?.available),
    ga4Available: Boolean(ga4Payload?.available),
  };
}
