import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import {
  getGoogleWarehouseHealth,
  warehouseSourceState,
  type WarehouseSourceHealth,
} from "@/lib/google/warehouse-health";
import { createClient } from "@/lib/supabase/server";

function value(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function pct(value: number | null | undefined) {
  return Number(value || 0).toFixed(2) + "%";
}

function date(value: string | null | undefined) {
  return value || "—";
}

function sourceLabel(key: "gsc" | "ga4") {
  return key === "gsc" ? "Google Search Console" : "Google Analytics 4";
}

function stateLabel(source: WarehouseSourceHealth | undefined) {
  const state = warehouseSourceState(source);
  if (state === "healthy") return "Healthy";
  if (state === "syncing") return "Syncing";
  if (state === "attention") return "Needs attention";
  return "Not configured";
}

function stateClass(source: WarehouseSourceHealth | undefined) {
  const state = warehouseSourceState(source);
  if (state === "healthy") return "healthGood";
  if (state === "attention") return "healthBad";
  return "";
}

export default async function DataHealthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, { data: recentLogs }] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,domain,project_type")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("google_sync_date_log")
      .select("source,date,status,total_rows,attempt_count,last_error,last_attempt_at,succeeded_at")
      .eq("project_id", id)
      .order("date", { ascending: false })
      .limit(40),
  ]);

  if (!project) notFound();

  let health = null;
  let healthError: string | null = null;

  try {
    health = await getGoogleWarehouseHealth(supabase, id);
  } catch (error) {
    healthError =
      error instanceof Error ? error.message : "Warehouse health could not be loaded.";
  }

  const sources = health?.sources || {};

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">First-party data reliability</p>
          <h1>{project.name} · Data Health</h1>
          <p className="muted">
            Date-level ingestion coverage for GSC and GA4. A successfully processed zero-row date
            counts as healthy coverage and is not mistaken for a sync gap.
          </p>
        </div>
      </header>

      <ProjectDataNav projectId={id} active="health" />

      {healthError ? (
        <section className="panel">
          <h2>Health query unavailable</h2>
          <p className="muted">{healthError}</p>
        </section>
      ) : null}

      <section className="healthGrid readinessStats">
        {(["gsc", "ga4"] as const).map((key) => {
          const source = sources[key];
          return (
            <article className="healthCard" key={key}>
              <span>{sourceLabel(key)}</span>
              <strong className={stateClass(source)}>{stateLabel(source)}</strong>
              <small>
                {source
                  ? pct(source.coverage_percent) + " coverage · " +
                    value(source.missing_days) + " missing"
                  : "No sync target yet"}
              </small>
            </article>
          );
        })}
        <article className="healthCard">
          <span>Successful dates</span>
          <strong>
            {value(
              Number(sources.gsc?.succeeded_dates || 0) +
                Number(sources.ga4?.succeeded_dates || 0),
            )}
          </strong>
          <small>Date-level ledger</small>
        </article>
        <article className="healthCard">
          <span>Failed dates</span>
          <strong
            className={
              Number(sources.gsc?.failed_dates || 0) +
                Number(sources.ga4?.failed_dates || 0) >
              0
                ? "healthBad"
                : "healthGood"
            }
          >
            {value(
              Number(sources.gsc?.failed_dates || 0) +
                Number(sources.ga4?.failed_dates || 0),
            )}
          </strong>
          <small>Unresolved date attempts</small>
        </article>
      </section>

      <div className="twoCol dataTwoCol">
        {(["gsc", "ga4"] as const).map((key) => {
          const source = sources[key];
          return (
            <section className="panel" key={key}>
              <div className="panelHeader">
                <div>
                  <h2>{sourceLabel(key)}</h2>
                  <p>{stateLabel(source)}</p>
                </div>
              </div>

              {!source || Number(source.target_days || 0) === 0 ? (
                <div className="emptyState smallEmpty">
                  <span>No warehouse sync target has been created yet.</span>
                </div>
              ) : (
                <div className="readinessList">
                  <div className="readinessRow">
                    <div className="readinessCopy">
                      <strong>Coverage</strong>
                      <span>
                        {value(source.succeeded_dates)} / {value(source.target_days)} expected dates
                      </span>
                    </div>
                    <div className="readinessRowActions">
                      <span>{pct(source.coverage_percent)}</span>
                    </div>
                  </div>
                  <div className="readinessRow">
                    <div className="readinessCopy">
                      <strong>Target range</strong>
                      <span>{date(source.target_start)} → {date(source.target_end)}</span>
                    </div>
                  </div>
                  <div className="readinessRow">
                    <div className="readinessCopy">
                      <strong>Successful range</strong>
                      <span>{date(source.min_success_date)} → {date(source.max_success_date)}</span>
                    </div>
                  </div>
                  <div className="readinessRow">
                    <div className="readinessCopy">
                      <strong>Queue</strong>
                      <span>
                        {value(source.queued_jobs)} queued · {value(source.running_jobs)} running ·{" "}
                        {value(source.failed_jobs)} failed
                      </span>
                    </div>
                  </div>
                  <div className="readinessRow">
                    <div className="readinessCopy">
                      <strong>Missing dates</strong>
                      <span>
                        {source.missing_date_sample?.length
                          ? source.missing_date_sample.join(", ")
                          : "No unresolved date gaps"}
                      </span>
                    </div>
                    <div className="readinessRowActions">
                      <span className={Number(source.missing_days || 0) ? "healthBad" : "healthGood"}>
                        {value(source.missing_days)}
                      </span>
                    </div>
                  </div>
                  <div className="readinessRow">
                    <div className="readinessCopy">
                      <strong>Last ingestion attempt</strong>
                      <span>{date(source.last_attempt_at)}</span>
                    </div>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Recent date-level ingestion</h2>
            <p>Latest 40 GSC / GA4 date outcomes recorded by the warehouse worker.</p>
          </div>
        </div>

        {recentLogs?.length ? (
          <div className="readinessList">
            {recentLogs.map((row) => (
              <div className="readinessRow" key={row.source + ":" + row.date}>
                <div className="readinessCopy">
                  <strong>{row.source.toUpperCase()} · {row.date}</strong>
                  <span>
                    {value(row.total_rows)} rows · attempt {value(row.attempt_count)}
                    {row.last_error ? " · " + row.last_error : ""}
                  </span>
                </div>
                <div className="readinessRowActions">
                  <span className={row.status === "succeeded" ? "healthGood" : "healthBad"}>
                    {row.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No dates have been processed by the new warehouse ledger yet.</span>
          </div>
        )}
      </section>
    </div>
  );
}
