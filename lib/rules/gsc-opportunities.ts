import { querySearchConsole, type GscRow } from "@/lib/google/search-console";

export type GscOpportunityCandidate = {
  fingerprint: string;
  title: string;
  summary: string;
  whyItMatters: string;
  importance: "high" | "medium" | "low";
  recommendedAction: string;
  affectedScope: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type Metrics = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

function metrics(row?: GscRow): Metrics {
  return {
    clicks: Number(row?.clicks || 0),
    impressions: Number(row?.impressions || 0),
    ctr: Number(row?.ctr || 0),
    position: Number(row?.position || 0),
  };
}

function rowMap(rows: GscRow[] | undefined) {
  const map = new Map<string, Metrics>();
  for (const row of rows || []) {
    const key = row.keys?.[0];
    if (!key) continue;
    map.set(key, metrics(row));
  }
  return map;
}

function importanceFromImpressions(impressions: number, clicks = 0): "high" | "medium" | "low" {
  if (impressions >= 5000 || clicks >= 100) return "high";
  if (impressions >= 500 || clicks >= 20) return "medium";
  return "low";
}

function pctChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 1 : 0;
  return (current - previous) / previous;
}

export async function detectGscOpportunities(input: {
  siteUrl: string;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
}) {
  const common = {
    siteUrl: input.siteUrl,
    searchType: "web" as const,
    dataState: "final" as const,
    rowLimit: 25000,
  };

  const [
    currentQueriesResponse,
    previousQueriesResponse,
    currentPagesResponse,
    previousPagesResponse,
    queryPageResponse,
  ] = await Promise.all([
    querySearchConsole({
      ...common,
      startDate: input.currentStart,
      endDate: input.currentEnd,
      dimensions: ["query"],
    }),
    querySearchConsole({
      ...common,
      startDate: input.previousStart,
      endDate: input.previousEnd,
      dimensions: ["query"],
    }),
    querySearchConsole({
      ...common,
      startDate: input.currentStart,
      endDate: input.currentEnd,
      dimensions: ["page"],
    }),
    querySearchConsole({
      ...common,
      startDate: input.previousStart,
      endDate: input.previousEnd,
      dimensions: ["page"],
    }),
    querySearchConsole({
      ...common,
      startDate: input.currentStart,
      endDate: input.currentEnd,
      dimensions: ["query", "page"],
    }),
  ]);

  const currentQueries = rowMap(currentQueriesResponse.rows);
  const previousQueries = rowMap(previousQueriesResponse.rows);
  const currentPages = rowMap(currentPagesResponse.rows);
  const previousPages = rowMap(previousPagesResponse.rows);
  const candidates: GscOpportunityCandidate[] = [];

  for (const [query, current] of currentQueries) {
    const previous = previousQueries.get(query) || {
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    };

    if (current.impressions >= 100 && current.position >= 5 && current.position <= 20) {
      candidates.push({
        fingerprint: `gsc:striking-distance:${query}`,
        title: `Striking-distance query: ${query}`,
        summary: `${current.impressions.toLocaleString()} impressions at average position ${current.position.toFixed(1)} in the current period.`,
        whyItMatters:
          "The query already has meaningful visibility and is close enough to stronger first-page positions to justify focused optimization.",
        importance: importanceFromImpressions(current.impressions, current.clicks),
        recommendedAction:
          "Review ranking URL intent match, content depth, title/H1 alignment, internal links and competing pages before deciding the optimization.",
        affectedScope: { query },
        metadata: { rule: "striking_distance", current, previous },
      });
    }

    if (
      current.impressions >= 200 &&
      current.position > 0 &&
      current.position <= 10 &&
      current.ctr < 0.02
    ) {
      candidates.push({
        fingerprint: `gsc:low-ctr:${query}`,
        title: `High-impression, low-CTR query: ${query}`,
        summary: `${current.impressions.toLocaleString()} impressions, ${(current.ctr * 100).toFixed(2)}% CTR and position ${current.position.toFixed(1)}.`,
        whyItMatters:
          "The query is already visible on page one but is converting relatively few impressions into clicks.",
        importance: importanceFromImpressions(current.impressions, current.clicks),
        recommendedAction:
          "Inspect the SERP, title/meta proposition, intent match and rich-result opportunities before changing the snippet.",
        affectedScope: { query },
        metadata: { rule: "high_impression_low_ctr", current, previous },
      });
    }

    const impressionChange = pctChange(current.impressions, previous.impressions);
    if (
      current.impressions >= 100 &&
      previous.impressions >= 20 &&
      impressionChange >= 0.5
    ) {
      candidates.push({
        fingerprint: `gsc:rising-query:${query}`,
        title: `Rising query: ${query}`,
        summary: `Impressions increased ${(impressionChange * 100).toFixed(0)}% versus the previous comparison period.`,
        whyItMatters:
          "Google is increasing visibility for this query, which can signal emerging relevance or demand worth reinforcing.",
        importance: importanceFromImpressions(current.impressions, current.clicks),
        recommendedAction:
          "Validate the ranking URL and search intent, then reinforce relevant sections/internal links if the opportunity is strategically relevant.",
        affectedScope: { query },
        metadata: { rule: "rising_query", current, previous, impressionChange },
      });
    }

    const clickChange = pctChange(current.clicks, previous.clicks);
    if (previous.clicks >= 10 && clickChange <= -0.3) {
      candidates.push({
        fingerprint: `gsc:declining-query:${query}`,
        title: `Declining query: ${query}`,
        summary: `Clicks decreased ${Math.abs(clickChange * 100).toFixed(0)}% versus the previous comparison period.`,
        whyItMatters:
          "A previously meaningful query is losing organic traffic and should be checked for ranking, CTR, intent or SERP changes.",
        importance: importanceFromImpressions(previous.impressions, previous.clicks),
        recommendedAction:
          "Compare position, impressions and CTR changes, then inspect the ranking URL and current SERP before selecting a fix.",
        affectedScope: { query },
        metadata: { rule: "declining_query", current, previous, clickChange },
      });
    }

    if (current.impressions >= 100 && previous.impressions === 0) {
      candidates.push({
        fingerprint: `gsc:new-query:${query}`,
        title: `New visibility query: ${query}`,
        summary: `The query generated ${current.impressions.toLocaleString()} impressions in the current period and was not present in the comparison set.`,
        whyItMatters:
          "New search visibility can reveal an emerging topic, intent or page opportunity before it becomes obvious in aggregate traffic.",
        importance: importanceFromImpressions(current.impressions, current.clicks),
        recommendedAction:
          "Confirm whether the ranking page is the intended destination and whether the query deserves dedicated or expanded coverage.",
        affectedScope: { query },
        metadata: { rule: "new_query", current, previous },
      });
    }
  }

  for (const [query, previous] of previousQueries) {
    const current = currentQueries.get(query);
    if (previous.impressions >= 100 && (!current || current.impressions < previous.impressions * 0.2)) {
      candidates.push({
        fingerprint: `gsc:lost-query:${query}`,
        title: `Lost visibility query: ${query}`,
        summary: `A query with ${previous.impressions.toLocaleString()} previous-period impressions has lost most of its visibility.`,
        whyItMatters:
          "A meaningful visibility loss can indicate ranking displacement, changed intent, technical issues or content decay.",
        importance: importanceFromImpressions(previous.impressions, previous.clicks),
        recommendedAction:
          "Check the previous ranking URL, current indexability/canonical state, SERP competitors and whether another internal URL replaced it.",
        affectedScope: { query },
        metadata: { rule: "lost_query", current: current || null, previous },
      });
    }
  }

  for (const [page, current] of currentPages) {
    const previous = previousPages.get(page);
    if (!previous || previous.clicks < 20) continue;
    const clickChange = pctChange(current.clicks, previous.clicks);
    if (clickChange <= -0.3) {
      candidates.push({
        fingerprint: `gsc:declining-page:${page}`,
        title: "Declining organic landing page",
        summary: `${page} lost ${Math.abs(clickChange * 100).toFixed(0)}% of clicks versus the previous comparison period.`,
        whyItMatters:
          "Page-level declines can aggregate multiple lost queries and often deserve a focused technical, intent and content review.",
        importance: importanceFromImpressions(previous.impressions, previous.clicks),
        recommendedAction:
          "Break the page down by queries, compare ranking/CTR changes and inspect technical state before deciding the remediation.",
        affectedScope: { page },
        metadata: { rule: "declining_page", current, previous, clickChange },
      });
    }
  }

  const queryPages = new Map<string, Array<{ page: string; metrics: Metrics }>>();
  for (const row of queryPageResponse.rows || []) {
    const query = row.keys?.[0];
    const page = row.keys?.[1];
    if (!query || !page || Number(row.impressions || 0) < 20) continue;
    const list = queryPages.get(query) || [];
    list.push({ page, metrics: metrics(row) });
    queryPages.set(query, list);
  }

  for (const [query, pages] of queryPages) {
    const meaningfulPages = pages
      .filter((item) => item.metrics.impressions >= 20)
      .sort((a, b) => b.metrics.impressions - a.metrics.impressions);

    if (meaningfulPages.length < 2) continue;

    const totalImpressions = meaningfulPages.reduce(
      (sum, item) => sum + item.metrics.impressions,
      0,
    );

    candidates.push({
      fingerprint: `gsc:multi-page-query:${query}`,
      title: `Multiple pages ranking for: ${query}`,
      summary: `${meaningfulPages.length} URLs received impressions for the same query in the current period.`,
      whyItMatters:
        "Multiple ranking URLs can be healthy intent coverage or harmful cannibalization. The pattern needs manual validation before action.",
      importance: importanceFromImpressions(totalImpressions),
      recommendedAction:
        "Compare the ranking URLs, intent, positions and query ownership. Consolidate only if the pages are genuinely competing for the same intent.",
      affectedScope: {
        query,
        pages: meaningfulPages.slice(0, 5).map((item) => item.page),
      },
      metadata: {
        rule: "multi_page_query",
        pages: meaningfulPages.slice(0, 10),
        totalImpressions,
      },
    });
  }

  const unique = new Map<string, GscOpportunityCandidate>();
  for (const candidate of candidates) unique.set(candidate.fingerprint, candidate);

  return Array.from(unique.values())
    .sort((a, b) => {
      const weight = { high: 3, medium: 2, low: 1 };
      return weight[b.importance] - weight[a.importance];
    })
    .slice(0, 500);
}
