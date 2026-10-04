import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const WORKER_LABELS: Record<string, string> = {
  "data-sync": "Google Data Sync",
  "technical-crawler": "Technical Crawl Scheduler",
  "crawl-worker": "Distributed Crawl Worker",
  "crawl-performance": "PageSpeed / CWV Worker",
  "rank-tracker": "Rank Tracker",
  "opportunity-engine": "Opportunity Engine",
  interventions: "Intervention Monitoring",
  "agent-scheduler": "Agent Scheduler",
  "sales-discovery": "Sales Discovery",
};

function duration(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return String(value) + " ms";
  if (value < 60_000) return (value / 1000).toFixed(1) + " s";
  return (value / 60_000).toFixed(1) + " min";
}

function statusClass(status: string) {
  if (status === "succeeded") return "healthGood";
  if (status === "failed") return "healthBad";
  return "";
}

function compactMetrics(value: unknown) {
  const input = (value || {}) as Record<string, unknown>;
  const preferred = [
    "processed",
    "jobs_processed",
    "processed_keywords",
    "evaluated",
    "failed",
    "partial",
    "due",
    "checked",
    "elapsed_ms",
    "discovery_cost",
  ];

  const parts = preferred
    .filter((key) => input[key] !== undefined && input[key] !== null)
    .map((key) => key.replaceAll("_", " ") + ": " + String(input[key]));

  if (parts.length) return parts.slice(0, 5).join(" · ");
  const entries = Object.entries(input).slice(0, 4);
  return entries.length
    ? entries.map(([key, val]) => key.replaceAll("_", " ") + ": " + String(val)).join(" · ")
    : "No metrics";
}

export default async function OperationsPage() {
  const supabase = await createClient();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();

  const [
    { data: runs },
    { count: queuedSync },
    { count: runningSync },
    { count: failedSync },
    { count: failedJobs },
    { count: runningJobs },
    { count: queuedCrawlUrls },
    { count: claimedCrawlUrls },
    { count: failedCrawlUrls },
    { count: runningCrawlRuns },
    { count: queuedPerformance },
  ] = await Promise.all([
    supabase
      .from("runtime_worker_runs")
      .select("id,batch_id,worker_key,status,metrics,metadata,error,started_at,completed_at,duration_ms")
      .order("started_at", { ascending: false })
      .limit(150),
    supabase
      .from("google_sync_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued"),
    supabase
      .from("google_sync_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "running"),
    supabase
      .from("google_sync_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running"),
    supabase
      .from("crawl_url_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued"),
    supabase
      .from("crawl_url_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "claimed"),
    supabase
      .from("crawl_url_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("crawl_runs")
      .select("id", { count: "exact", head: true })
      .eq("execution_mode", "queue")
      .eq("status", "running"),
    supabase
      .from("crawl_performance_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued"),
  ]);

  const recent = (runs || []).filter((run) => run.started_at >= dayAgo);
  const recentSucceeded = recent.filter((run) => run.status === "succeeded").length;
  const recentPartial = recent.filter((run) => run.status === "partial").length;
  const recentFailed = recent.filter((run) => run.status === "failed").length;
  const staleRuns = (runs || []).filter(
    (run) => run.status === "running" && run.started_at < staleCutoff,
  );

  const completedDurations = recent
    .map((run) => run.duration_ms)
    .filter((value): value is number => typeof value === "number");
  const averageDuration = completedDurations.length
    ? Math.round(
        completedDurations.reduce((sum, value) => sum + value, 0) /
          completedDurations.length,
      )
    : null;

  const latestByWorker = new Map<string, NonNullable<typeof runs>[number]>();
  for (const run of runs || []) {
    if (!latestByWorker.has(run.worker_key)) {
      latestByWorker.set(run.worker_key, run);
    }
  }

  const workers = Object.keys(WORKER_LABELS);

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Production operations</p>
          <h1>Operations</h1>
          <p className="muted">
            Owner-scoped worker history, queue state, failures and runtime duration.
            This is the operational layer for scheduled SignalCore work.
          </p>
        </div>
        <Link href="/readiness" className="secondaryButton">System Readiness</Link>
      </header>

      <section className="healthGrid">
        <article className="healthCard">
          <span>24h successful</span>
          <strong className="healthGood">{recentSucceeded}</strong>
          <small>Completed worker runs</small>
        </article>
        <article className="healthCard">
          <span>24h partial</span>
          <strong>{recentPartial}</strong>
          <small>Completed with warnings</small>
        </article>
        <article className="healthCard">
          <span>24h failed</span>
          <strong className={recentFailed ? "healthBad" : "healthGood"}>{recentFailed}</strong>
          <small>Needs investigation</small>
        </article>
        <article className="healthCard">
          <span>Stale worker runs</span>
          <strong className={staleRuns.length ? "healthBad" : "healthGood"}>
            {staleRuns.length}
          </strong>
          <small>Running longer than 15 min</small>
        </article>
        <article className="healthCard">
          <span>Average duration</span>
          <strong>{duration(averageDuration)}</strong>
          <small>Last 24 hours</small>
        </article>
        <article className="healthCard">
          <span>Google sync queue</span>
          <strong>{(queuedSync || 0) + (runningSync || 0)}</strong>
          <small>
            {queuedSync || 0} queued · {runningSync || 0} running · {failedSync || 0} failed
          </small>
        </article>
        <article className="healthCard">
          <span>Distributed crawl queue</span>
          <strong>
            {(queuedCrawlUrls || 0) + (claimedCrawlUrls || 0)}
          </strong>
          <small>
            {runningCrawlRuns || 0} run(s) · {queuedCrawlUrls || 0} queued ·{" "}
            {claimedCrawlUrls || 0} claimed · {failedCrawlUrls || 0} failed
          </small>
        </article>
        <article className="healthCard">
          <span>PageSpeed queue</span>
          <strong>{queuedPerformance || 0}</strong>
          <small>Selective CWV samples waiting</small>
        </article>
        <article className="healthCard">
          <span>Generic jobs</span>
          <strong className={failedJobs ? "healthBad" : ""}>{failedJobs || 0}</strong>
          <small>{runningJobs || 0} running · {failedJobs || 0} failed</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Worker health</h2>
            <p>Latest owner-visible run for every production worker.</p>
          </div>
        </div>
        <div className="readinessList">
          {workers.map((workerKey) => {
            const latest = latestByWorker.get(workerKey);
            return (
              <div className="readinessRow" key={workerKey}>
                <div className="readinessCopy">
                  <strong>{WORKER_LABELS[workerKey]}</strong>
                  <span>
                    {latest
                      ? new Date(latest.started_at).toLocaleString("en-GB") +
                        " · " +
                        compactMetrics(latest.metrics)
                      : "No production run recorded yet"}
                  </span>
                </div>
                <div className="readinessRowActions">
                  <span className={latest ? statusClass(latest.status) : ""}>
                    {latest?.status || "waiting"}
                  </span>
                  <span>{latest ? duration(latest.duration_ms) : "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Recent worker runs</h2>
            <p>Latest 150 owner-scoped operations.</p>
          </div>
        </div>

        {(runs || []).length ? (
          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Metrics</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {(runs || []).map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.started_at).toLocaleString("en-GB")}</td>
                    <td>{WORKER_LABELS[run.worker_key] || run.worker_key}</td>
                    <td>
                      <span className={statusClass(run.status)}>{run.status}</span>
                    </td>
                    <td>{duration(run.duration_ms)}</td>
                    <td><span className="cellEllipsis">{compactMetrics(run.metrics)}</span></td>
                    <td>
                      <span className="cellEllipsis">{run.error || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <strong>No runtime worker history yet</strong>
            <span>The first records will appear after the new cron runtime is deployed.</span>
          </div>
        )}
      </section>
    </div>
  );
}
