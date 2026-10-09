import type { SupabaseClient } from "@supabase/supabase-js";
import { getProjectGoogleResource } from "@/lib/google/project-resource";
import {
  querySearchConsole,
  type GscDimension,
  type GscFilter,
  type GscRow,
} from "@/lib/google/search-console";

export type LiveGscMetric = "clicks" | "impressions";

export type LiveGscRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

function addDays(iso: string, days: number) {
  const date = new Date(iso + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function defaultGscWindow(days: number) {
  const requestedDays = Math.min(Math.max(Math.floor(days || 28), 1), 480);
  // GSC final data normally lags. Use the latest stable date instead of
  // forcing the warehouse to be prefilled day by day.
  const today = new Date();
  const end = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  end.setUTCDate(end.getUTCDate() - 2);
  const endDate = end.toISOString().slice(0, 10);
  return {
    days: requestedDays,
    startDate: addDays(endDate, -(requestedDays - 1)),
    endDate,
  };
}

async function fetchAllRows(input: {
  client: SupabaseClient;
  projectId: string;
  dimensions: GscDimension[];
  startDate: string;
  endDate: string;
  filters?: GscFilter[];
  maxRows?: number;
}) {
  const resource = await getProjectGoogleResource(
    input.projectId,
    "gsc",
    input.client,
  );
  const maxRows = Math.min(Math.max(input.maxRows || 100000, 1), 300000);
  const rows: LiveGscRow[] = [];
  let startRow = 0;

  while (rows.length < maxRows) {
    const response = await querySearchConsole(
      {
        siteUrl: resource.resource_id,
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions,
        searchType: "web",
        dataState: "final",
        filters: input.filters,
        rowLimit: 25000,
        startRow,
      },
      input.client,
    );

    const batch = (response.rows || []).map((row: GscRow) => ({
      keys: row.keys || [],
      clicks: Number(row.clicks || 0),
      impressions: Number(row.impressions || 0),
      ctr: Number(row.ctr || 0),
      position: Number(row.position || 0),
    }));
    rows.push(...batch);
    if (batch.length < 25000 || rows.length >= maxRows) break;
    startRow += batch.length;
  }

  return rows.slice(0, maxRows);
}

function sortByMetric(rows: LiveGscRow[], metric: LiveGscMetric) {
  return [...rows].sort((a, b) => {
    const primary =
      metric === "impressions"
        ? b.impressions - a.impressions
        : b.clicks - a.clicks;
    if (primary !== 0) return primary;
    return metric === "impressions"
      ? b.clicks - a.clicks
      : b.impressions - a.impressions;
  });
}

export async function getLiveGscTopQueries(input: {
  client: SupabaseClient;
  projectId: string;
  days: number;
  metric: LiveGscMetric;
  limit: number;
}) {
  const window = defaultGscWindow(input.days);
  const rows = await fetchAllRows({
    client: input.client,
    projectId: input.projectId,
    dimensions: ["query"],
    startDate: window.startDate,
    endDate: window.endDate,
    maxRows: 100000,
  });

  return {
    source: "gsc_live" as const,
    ...window,
    metric: input.metric,
    rows: sortByMetric(rows, input.metric)
      .filter((row) => row.keys[0])
      .slice(0, Math.min(Math.max(input.limit, 1), 100))
      .map((row, index) => ({
        query: row.keys[0]!,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        rank_order: index + 1,
      })),
  };
}

export async function getLiveGscTopPages(input: {
  client: SupabaseClient;
  projectId: string;
  days: number;
  metric: LiveGscMetric;
  limit: number;
  pageContains?: string | null;
}) {
  const window = defaultGscWindow(input.days);
  const filters: GscFilter[] = [];
  if (input.pageContains?.trim()) {
    filters.push({
      dimension: "page",
      operator: "contains",
      expression: input.pageContains.trim(),
    });
  }

  const rows = await fetchAllRows({
    client: input.client,
    projectId: input.projectId,
    dimensions: ["page"],
    startDate: window.startDate,
    endDate: window.endDate,
    filters,
    maxRows: 100000,
  });

  return {
    source: "gsc_live" as const,
    ...window,
    metric: input.metric,
    pageContains: input.pageContains || null,
    rows: sortByMetric(rows, input.metric)
      .filter((row) => row.keys[0])
      .slice(0, Math.min(Math.max(input.limit, 1), 100))
      .map((row, index) => ({
        page: row.keys[0]!,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        rank_order: index + 1,
      })),
  };
}

export async function getLiveGscQueriesForPages(input: {
  client: SupabaseClient;
  projectId: string;
  days: number;
  pages: string[];
  metric?: LiveGscMetric;
  keywordsPerPage?: number;
}) {
  const window = defaultGscWindow(input.days);
  const metric = input.metric || "clicks";
  const keywordsPerPage = Math.min(
    Math.max(input.keywordsPerPage || 10, 1),
    100,
  );
  const output: Array<{
    page: string;
    queries: Array<{
      query: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
      rank_order: number;
    }>;
  }> = [];

  for (const page of input.pages.slice(0, 30)) {
    const rows = await fetchAllRows({
      client: input.client,
      projectId: input.projectId,
      dimensions: ["query"],
      startDate: window.startDate,
      endDate: window.endDate,
      filters: [
        {
          dimension: "page",
          operator: "equals",
          expression: page,
        },
      ],
      maxRows: 25000,
    });

    output.push({
      page,
      queries: sortByMetric(rows, metric)
        .filter((row) => row.keys[0])
        .slice(0, keywordsPerPage)
        .map((row, index) => ({
          query: row.keys[0]!,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          rank_order: index + 1,
        })),
    });
  }

  return {
    source: "gsc_live" as const,
    ...window,
    metric,
    pages: output,
  };
}
