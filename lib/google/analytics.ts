import type { SupabaseClient } from "@supabase/supabase-js";
import { getGoogleAccessToken } from "@/lib/google/access-token";

export type Ga4Filter = {
  fieldName: string;
  matchType?: "EXACT" | "CONTAINS" | "BEGINS_WITH" | "ENDS_WITH" | "FULL_REGEXP" | "PARTIAL_REGEXP";
  value: string;
  caseSensitive?: boolean;
};

export type Ga4RunReportInput = {
  property: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
  dimensionFilters?: Ga4Filter[];
  limit?: number;
  offset?: number;
};

export type Ga4Header = { name?: string; type?: string };
export type Ga4Row = {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
};

export type Ga4ReportResponse = {
  dimensionHeaders?: Ga4Header[];
  metricHeaders?: Ga4Header[];
  rows?: Ga4Row[];
  rowCount?: number;
  totals?: Ga4Row[];
  metadata?: Record<string, unknown>;
};

function dimensionFilterExpression(filters: Ga4Filter[]) {
  const valid = filters.filter((filter) => filter.fieldName && filter.value);
  if (!valid.length) return undefined;

  const expressions = valid.map((filter) => ({
    filter: {
      fieldName: filter.fieldName,
      stringFilter: {
        matchType: filter.matchType || "CONTAINS",
        value: filter.value,
        caseSensitive: Boolean(filter.caseSensitive),
      },
    },
  }));

  return expressions.length === 1
    ? expressions[0]
    : { andGroup: { expressions } };
}

export async function runGa4Report(input: Ga4RunReportInput, client?: SupabaseClient) {
  const { accessToken } = await getGoogleAccessToken(client);

  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name })),
    limit: String(Math.min(Math.max(input.limit || 100, 1), 10000)),
    offset: String(Math.max(input.offset || 0, 0)),
    returnPropertyQuota: true,
    metricAggregations: ["TOTAL"],
  };

  const filterExpression = dimensionFilterExpression(input.dimensionFilters || []);
  if (filterExpression) body.dimensionFilter = filterExpression;

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/${input.property}:runReport`,
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

  const payload = (await response.json()) as Ga4ReportResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message || "GA4 report query failed.");
  }

  return payload;
}

export type FunnelStepInput = {
  name: string;
  eventName: string;
};

export type Ga4FunnelResponse = {
  funnelTable?: {
    dimensionHeaders?: Ga4Header[];
    metricHeaders?: Ga4Header[];
    rows?: Ga4Row[];
  };
  funnelVisualization?: {
    dimensionHeaders?: Ga4Header[];
    metricHeaders?: Ga4Header[];
    rows?: Ga4Row[];
  };
};

export async function runGa4Funnel(input: {
  property: string;
  startDate: string;
  endDate: string;
  steps: FunnelStepInput[];
  breakdownDimension?: string;
  isOpenFunnel?: boolean;
}, client?: SupabaseClient) {
  const { accessToken } = await getGoogleAccessToken(client);

  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
    funnel: {
      isOpenFunnel: Boolean(input.isOpenFunnel),
      steps: input.steps
        .filter((step) => step.name && step.eventName)
        .map((step) => ({
          name: step.name,
          filterExpression: {
            funnelEventFilter: {
              eventName: step.eventName,
            },
          },
        })),
    },
    limit: "1000",
    returnPropertyQuota: true,
  };

  if (input.breakdownDimension) {
    body.funnelBreakdown = {
      breakdownDimension: { name: input.breakdownDimension },
    };
  }

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1alpha/${input.property}:runFunnelReport`,
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

  const payload = (await response.json()) as Ga4FunnelResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message || "GA4 funnel query failed.");
  }

  return payload;
}
