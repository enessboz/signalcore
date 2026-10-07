import type { SupabaseClient } from "@supabase/supabase-js";

export type WarehouseSourceHealth = {
  target_start: string | null;
  target_end: string | null;
  target_days: number;
  succeeded_dates: number;
  failed_dates: number;
  missing_days: number;
  coverage_percent: number;
  min_success_date: string | null;
  max_success_date: string | null;
  freshness_days: number | null;
  queued_jobs: number;
  running_jobs: number;
  failed_jobs: number;
  last_attempt_at: string | null;
  missing_date_sample: string[];
};

export type GoogleWarehouseHealth = {
  project_id: string;
  generated_at: string;
  sources: {
    gsc?: WarehouseSourceHealth;
    ga4?: WarehouseSourceHealth;
  };
};

export type WarehouseHealthState =
  | "not_configured"
  | "syncing"
  | "healthy"
  | "attention";

function n(value: unknown) {
  return Number(value || 0);
}

export function warehouseSourceState(
  source: WarehouseSourceHealth | null | undefined,
): WarehouseHealthState {
  if (!source || n(source.target_days) === 0) return "not_configured";

  if (n(source.failed_jobs) > 0) return "attention";

  if (
    n(source.missing_days) > 0 &&
    n(source.queued_jobs) + n(source.running_jobs) > 0
  ) {
    return "syncing";
  }

  if (n(source.failed_dates) > 0 || n(source.missing_days) > 0) {
    return "attention";
  }

  return "healthy";
}

export async function getGoogleWarehouseHealth(
  client: SupabaseClient,
  projectId: string,
) {
  const { data, error } = await client.rpc("get_google_warehouse_health", {
    p_project_id: projectId,
  });

  if (error) {
    throw new Error("Warehouse health query failed: " + error.message);
  }

  return (data || null) as GoogleWarehouseHealth | null;
}

type HealthFinding = {
  fingerprint: string;
  title: string;
  summary: string;
  whyItMatters: string;
  importance: "critical" | "high" | "medium" | "low";
  recommendedAction: string;
  metadata: Record<string, unknown>;
};

function findingForSource(
  sourceName: "gsc" | "ga4",
  source: WarehouseSourceHealth,
): HealthFinding | null {
  const label = sourceName === "gsc" ? "Google Search Console" : "Google Analytics 4";
  const activeJobs = n(source.queued_jobs) + n(source.running_jobs);

  if (n(source.failed_jobs) > 0) {
    return {
      fingerprint: "data-health:" + sourceName + ":failed-jobs",
      title: label + " warehouse sync has failed jobs",
      summary:
        String(source.failed_jobs) +
        " terminal sync job(s) require review before warehouse coverage can be trusted.",
      whyItMatters:
        "Downstream SEO findings and intervention measurements should not be treated as complete while first-party ingestion is failing.",
      importance: "high",
      recommendedAction:
        "Review the failed Google sync job error, repair credentials or API conditions if needed, then requeue only the failed date range.",
      metadata: {
        source: sourceName,
        rule: "terminal_sync_failure",
        health: source,
      },
    };
  }

  if (n(source.missing_days) > 0 && activeJobs === 0) {
    return {
      fingerprint: "data-health:" + sourceName + ":coverage-gap",
      title: label + " warehouse has unresolved date gaps",
      summary:
        String(source.missing_days) +
        " expected date(s) are not marked as successfully ingested and no active sync job is repairing them.",
      whyItMatters:
        "Period comparisons can become biased when the underlying first-party date coverage is incomplete.",
      importance: n(source.missing_days) >= 7 ? "high" : "medium",
      recommendedAction:
        "Queue a repair sync for the missing dates shown by Data Health before relying on comparison-based opportunities.",
      metadata: {
        source: sourceName,
        rule: "warehouse_date_gap",
        health: source,
      },
    };
  }

  if (n(source.failed_dates) > 0 && activeJobs === 0) {
    return {
      fingerprint: "data-health:" + sourceName + ":failed-dates",
      title: label + " contains failed ingestion dates",
      summary:
        String(source.failed_dates) +
        " date-level ingestion record(s) remain failed after the current sync queue finished.",
      whyItMatters:
        "A failed date can silently weaken trend and attribution analysis even when later dates are healthy.",
      importance: "medium",
      recommendedAction:
        "Run a targeted repair for the failed dates and confirm they become succeeded in the sync ledger.",
      metadata: {
        source: sourceName,
        rule: "failed_ingestion_dates",
        health: source,
      },
    };
  }

  return null;
}

const HEALTH_FINGERPRINTS = [
  "data-health:gsc:failed-jobs",
  "data-health:gsc:coverage-gap",
  "data-health:gsc:failed-dates",
  "data-health:ga4:failed-jobs",
  "data-health:ga4:coverage-gap",
  "data-health:ga4:failed-dates",
];

export async function evaluateGoogleWarehouseHealth(input: {
  client: SupabaseClient;
  projectId: string;
  ownerId: string;
}) {
  const health = await getGoogleWarehouseHealth(input.client, input.projectId);
  if (!health) {
    return { health: null, opened: 0, resolved: 0 };
  }

  const candidates = (["gsc", "ga4"] as const)
    .map((sourceName) => {
      const source = health.sources?.[sourceName];
      return source ? findingForSource(sourceName, source) : null;
    })
    .filter((item): item is HealthFinding => Boolean(item));

  const activeFingerprints = new Set(candidates.map((item) => item.fingerprint));
  let opened = 0;
  let resolved = 0;

  for (const candidate of candidates) {
    const { error } = await input.client.from("findings").upsert(
      {
        project_id: input.projectId,
        owner_id: input.ownerId,
        finding_type: "data_health",
        title: candidate.title,
        summary: candidate.summary,
        why_it_matters: candidate.whyItMatters,
        importance: candidate.importance,
        confidence: "high",
        status: "open",
        fingerprint: candidate.fingerprint,
        affected_scope: { source: candidate.metadata.source },
        recommended_action: candidate.recommendedAction,
        metadata: candidate.metadata,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,fingerprint" },
    );

    if (error) {
      throw new Error("Data health finding upsert failed: " + error.message);
    }
    opened += 1;
  }

  const toResolve = HEALTH_FINGERPRINTS.filter(
    (fingerprint) => !activeFingerprints.has(fingerprint),
  );

  if (toResolve.length) {
    const { data, error } = await input.client
      .from("findings")
      .update({
        status: "resolved",
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .eq("finding_type", "data_health")
      .in("fingerprint", toResolve)
      .in("status", ["open", "monitoring"])
      .select("id");

    if (error) {
      throw new Error("Data health finding resolution failed: " + error.message);
    }
    resolved = data?.length || 0;
  }

  return { health, opened, resolved };
}
