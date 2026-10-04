import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { setFindingStatus } from "./actions";

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
  const statusFilter = scalar(query.status, "open");

  const { data: projects } = await supabase
    .from("projects")
    .select("id,name,domain")
    .order("name");

  let findingsQuery = supabase
    .from("findings")
    .select("id,project_id,title,summary,why_it_matters,importance,confidence,status,affected_scope,recommended_action,metadata,last_seen_at,updated_at")
    .in("finding_type", ["opportunity", "strategy_discovery"])
    .order("updated_at", { ascending: false })
    .limit(300);

  if (projectFilter) findingsQuery = findingsQuery.eq("project_id", projectFilter);
  if (importanceFilter) findingsQuery = findingsQuery.eq("importance", importanceFilter);
  if (statusFilter !== "all") findingsQuery = findingsQuery.eq("status", statusFilter);

  const { data: findings, error } = await findingsQuery;
  const projectMap = new Map((projects || []).map((project) => [project.id, project]));

  const ordered = [...(findings || [])].sort((a, b) => {
    const importanceDiff = importanceRank(b.importance) - importanceRank(a.importance);
    if (importanceDiff) return importanceDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const returnParams = new URLSearchParams();
  if (projectFilter) returnParams.set("project", projectFilter);
  if (importanceFilter) returnParams.set("importance", importanceFilter);
  if (statusFilter) returnParams.set("status", statusFilter);
  const returnTo = `/opportunities${returnParams.toString() ? `?${returnParams.toString()}` : ""}`;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Intelligence inbox</p>
          <h1>Opportunities</h1>
          <p className="muted">
            Deterministic candidates first. SEO Lead reasoning will be layered on top later.
          </p>
        </div>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}
      {error ? <p className="formMessage formError pageMessage">{error.message}</p> : null}

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
                  <Link href={`/projects/${project.id}/search-console`} className="ghostButton">
                    Open GSC
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
            <span>Run a GSC Opportunity Scan from a project’s Search Console workspace.</span>
          </section>
        )}
      </section>
    </div>
  );
}
