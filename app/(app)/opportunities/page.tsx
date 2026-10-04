import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  runWarehouseOpportunityScan,
  saveOpportunityAutomation,
  setFindingStatus,
} from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function importanceRank(value: string) {
  return value === "critical" ? 4 : value === "high" ? 3 : value === "medium" ? 2 : 1;
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const supabase = await createClient();

  const projectFilter = scalar(query.project);
  const importanceFilter = scalar(query.importance);
  const typeFilter = scalar(query.type);
  const statusFilter = scalar(query.status, "open");

  const [{ data: projects }, { data: automationSettings }] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,domain")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("opportunity_scan_settings")
      .select("project_id,enabled,scan_gsc,scan_ga4,scan_rank,cadence,last_run_at,last_data_date,last_status,last_error,consecutive_failures")
      .order("updated_at", { ascending: false }),
  ]);

  let findingsQuery = supabase
    .from("findings")
    .select("id,project_id,finding_type,title,summary,why_it_matters,importance,confidence,status,affected_scope,recommended_action,metadata,last_seen_at,updated_at")
    .in("finding_type", [
      "opportunity",
      "strategy_discovery",
      "regression",
      "issue",
      "observation",
    ])
    .order("updated_at", { ascending: false })
    .limit(300);

  if (projectFilter) findingsQuery = findingsQuery.eq("project_id", projectFilter);
  if (importanceFilter) findingsQuery = findingsQuery.eq("importance", importanceFilter);
  if (typeFilter) findingsQuery = findingsQuery.eq("finding_type", typeFilter);
  if (statusFilter !== "all") findingsQuery = findingsQuery.eq("status", statusFilter);

  const { data: findings, error } = await findingsQuery;
  const projectMap = new Map((projects || []).map((project) => [project.id, project]));
  const settingsMap = new Map(
    (automationSettings || []).map((item) => [item.project_id, item]),
  );
  const selectedAutomation = projectFilter
    ? settingsMap.get(projectFilter) || null
    : null;

  const ordered = [...(findings || [])].sort((a, b) => {
    const importanceDiff = importanceRank(b.importance) - importanceRank(a.importance);
    if (importanceDiff) return importanceDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const returnParams = new URLSearchParams();
  if (projectFilter) returnParams.set("project", projectFilter);
  if (importanceFilter) returnParams.set("importance", importanceFilter);
  if (typeFilter) returnParams.set("type", typeFilter);
  if (statusFilter) returnParams.set("status", statusFilter);
  const returnTo = `/opportunities${returnParams.toString() ? `?${returnParams.toString()}` : ""}`;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Intelligence inbox</p>
          <h1>Opportunities</h1>
          <p className="muted">
            Deterministic SEO intelligence from GSC, GA4, rank history and technical evidence.
            Findings explain why they matter before any action is taken.
          </p>
        </div>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}
      {error ? <p className="formMessage formError pageMessage">{error.message}</p> : null}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Automatic Opportunity Engine</h2>
            <p>
              Warehouse-first detection. No model is required to collect or compare
              GSC/GA4/rank evidence.
            </p>
          </div>
          {projectFilter ? (
            <form action={runWarehouseOpportunityScan.bind(null, projectFilter)}>
              <button className="primaryButton" type="submit">
                Run selected project now
              </button>
            </form>
          ) : null}
        </div>

        <form className="opportunityAutomationForm" action={saveOpportunityAutomation}>
          <label>
            Project
            <select name="projectId" required defaultValue={projectFilter}>
              <option value="" disabled>Select project</option>
              {(projects || []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <label className="checkboxLabel">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={Boolean(selectedAutomation?.enabled)}
            />
            Enable automation
          </label>

          <label className="checkboxLabel">
            <input
              name="scanGsc"
              type="checkbox"
              defaultChecked={selectedAutomation?.scan_gsc !== false}
            />
            GSC warehouse
          </label>

          <label className="checkboxLabel">
            <input
              name="scanGa4"
              type="checkbox"
              defaultChecked={selectedAutomation?.scan_ga4 !== false}
            />
            GA4 warehouse
          </label>

          <label className="checkboxLabel">
            <input
              name="scanRank"
              type="checkbox"
              defaultChecked={selectedAutomation?.scan_rank !== false}
            />
            Rank cross-check
          </label>

          <label>
            Cadence
            <select
              name="cadence"
              defaultValue={selectedAutomation?.cadence || "daily"}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          <button className="secondaryButton" type="submit">
            Save automation
          </button>
        </form>

        {projectFilter ? (
          <div className="opportunityAutomationState">
            <span>
              State: <strong>{selectedAutomation?.last_status || "not configured"}</strong>
            </span>
            <span>
              Last run:{" "}
              <strong>
                {selectedAutomation?.last_run_at
                  ? new Date(selectedAutomation.last_run_at).toLocaleString("en-GB")
                  : "never"}
              </strong>
            </span>
            <span>
              Latest data: <strong>{selectedAutomation?.last_data_date || "—"}</strong>
            </span>
            {selectedAutomation?.last_error ? (
              <span className="formError">{selectedAutomation.last_error}</span>
            ) : null}
          </div>
        ) : (
          <p className="muted">
            Select a project in the filters below to inspect its current automation state.
          </p>
        )}
      </section>

      <section className="panel filterPanel">
        <form method="get" className="filterForm">
          <label>
            Project
            <select name="project" defaultValue={projectFilter}>
              <option value="">All projects</option>
              {(projects || []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <label>
            Importance
            <select name="importance" defaultValue={importanceFilter}>
              <option value="">All importance</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>

          <label>
            Type
            <select name="type" defaultValue={typeFilter}>
              <option value="">All intelligence</option>
              <option value="opportunity">Opportunity</option>
              <option value="strategy_discovery">Strategy discovery</option>
              <option value="regression">Regression</option>
              <option value="issue">Issue</option>
              <option value="observation">Observation</option>
            </select>
          </label>

          <label>
            Status
            <select name="status" defaultValue={statusFilter}>
              <option value="open">Open</option>
              <option value="monitoring">Monitoring</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All</option>
            </select>
          </label>

          <button className="secondaryButton" type="submit">Apply filters</button>
        </form>
      </section>

      <section className="opportunitySummary">
        <div><strong>{ordered.length}</strong><span>visible findings</span></div>
        <div><strong>{ordered.filter((item) => item.importance === "high").length}</strong><span>high importance</span></div>
        <div><strong>{ordered.filter((item) => item.confidence === "high").length}</strong><span>high confidence</span></div>
        <div><strong>{new Set(ordered.map((item) => item.project_id)).size}</strong><span>projects affected</span></div>
      </section>

      <section className="opportunityList">
        {ordered.length ? ordered.map((finding) => {
          const project = projectMap.get(finding.project_id);
          const metadata = (finding.metadata || {}) as Record<string, unknown>;
          const source = String(metadata.source || "unknown");
          const rule = String(metadata.rule || "");
          const scope = (finding.affected_scope || {}) as Record<string, unknown>;

          return (
            <article className="opportunityCard" key={finding.id}>
              <div className="opportunityTopline">
                <div className="opportunityBadges">
                  <span className={`importance importance-${finding.importance}`}>{finding.importance}</span>
                  <span className="confidence">{finding.confidence} confidence</span>
                  <span className="sourceBadge">{finding.finding_type.replaceAll("_", " ")}</span>
                  <span className="sourceBadge">{source}</span>
                  {rule ? <span className="sourceBadge">{rule.replaceAll("_", " ")}</span> : null}
                </div>
                <span className="muted">{new Date(finding.last_seen_at).toLocaleDateString("en-GB")}</span>
              </div>

              <div className="opportunityHeader">
                <div>
                  <p className="eyebrow">{project?.name || "Unknown project"}</p>
                  <h2>{finding.title}</h2>
                  <p>{finding.summary}</p>
                </div>
                {project ? (
                  <Link
                    href={
                      source === "ga4_warehouse"
                        ? "/projects/" + project.id + "/analytics"
                        : source === "rank_tracker" || source === "cross_source"
                          ? "/projects/" + project.id + "/rank-tracker"
                          : source === "http_crawl"
                            ? "/projects/" + project.id + "/technical"
                            : "/projects/" + project.id + "/search-console"
                    }
                    className="ghostButton"
                  >
                    Open evidence
                  </Link>
                ) : null}
              </div>

              <div className="opportunityGrid">
                <div>
                  <strong>Why it matters</strong>
                  <p>{finding.why_it_matters || "No explanation stored yet."}</p>
                </div>
                <div>
                  <strong>Recommended action</strong>
                  <p>{finding.recommended_action || "No action stored yet."}</p>
                </div>
              </div>

              {Object.keys(scope).length ? (
                <details className="evidenceDetails">
                  <summary>Affected scope</summary>
                  <pre>{JSON.stringify(scope, null, 2)}</pre>
                </details>
              ) : null}

              <div className="opportunityActions">
                {finding.status !== "monitoring" ? (
                  <form action={setFindingStatus.bind(null, finding.id, "monitoring", returnTo)}>
                    <button className="secondaryButton" type="submit">Monitor</button>
                  </form>
                ) : null}
                {finding.status !== "resolved" ? (
                  <form action={setFindingStatus.bind(null, finding.id, "resolved", returnTo)}>
                    <button className="secondaryButton" type="submit">Resolve</button>
                  </form>
                ) : null}
                {finding.status !== "dismissed" ? (
                  <form action={setFindingStatus.bind(null, finding.id, "dismissed", returnTo)}>
                    <button className="ghostButton" type="submit">Dismiss</button>
                  </form>
                ) : null}
                <span className="statusText">Status: {finding.status}</span>
              </div>
            </article>
          );
        }) : (
          <section className="panel emptyState">
            <strong>No matching opportunities</strong>
            <span>Enable the Automatic Opportunity Engine or run a project scan manually.</span>
          </section>
        )}
      </section>
    </div>
  );
}
