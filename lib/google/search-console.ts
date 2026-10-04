import { getGoogleAccessToken } from "@/lib/google/access-token";

export type GscDimension =
  | "date"
  | "query"
  | "page"
  | "country"
  | "device"
  | "searchAppearance";

export type GscFilter = {
  dimension: Exclude<GscDimension, "date">;
  operator:
    | "equals"
    | "notEquals"
    | "contains"
    | "notContains"
    | "includingRegex"
    | "excludingRegex";
  expression: string;
};

export type GscQueryInput = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: GscDimension[];
  searchType?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  dataState?: "final" | "all";
  filters?: GscFilter[];
  rowLimit?: number;
  startRow?: number;
};

export type GscRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

export type GscResponse = {
  rows?: GscRow[];
  responseAggregationType?: string;
  metadata?: {
    first_incomplete_date?: string;
  };
};

export async function querySearchConsole(input: GscQueryInput) {
  const { accessToken } = await getGoogleAccessToken();
  const filters = (input.filters || []).filter((filter) => filter.expression.trim());

  const body: Record<string, unknown> = {
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions: input.dimensions || [],
    type: input.searchType || "web",
    dataState: input.dataState || "final",
    rowLimit: Math.min(Math.max(input.rowLimit || 100, 1), 25000),
    startRow: Math.max(input.startRow || 0, 0),
  };

  if (filters.length) {
    body.dimensionFilterGroups = [
      {
        groupType: "and",
        filters: filters.map((filter) => ({
          dimension: filter.dimension,
          operator: filter.operator,
          expression: filter.expression,
        })),
      },
    ];
  }

  const response = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(input.siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );

  const payload = (await response.json()) as GscResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message || "Search Console query failed.");
  }

  return payload;
}
