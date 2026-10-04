import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB");
}

function statusClass(status: string) {
  if (status === "succeeded" || status === "connected") return "healthGood";
  if (status === "failed" || status === "error" || status === "revoked") return "healthBad";
  if (status === "running" || status === "queued" || status === "connecting") return "healthWarn";
  return "healthNeutral";
}

export default async function AutomationsPage() {
  const supabase = await createClient();

  const [
    { data: projects },
    { data: jobs },
    { data: connections },
    { data: resources },
    { data: bindings },
    { count: pendingApprovals },
  ] = await Promise.all([
    supabase.from("projects").select("id,name,domain").order("name"),
    supabase
      .from("jobs")
      .select("id,project_id,job_type,trigger_type,status,result_summary,estimated_cost,actual_cost,started_at,completed_at,created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("connections")
      .select("id,provider,status,external_account,last_discovery_at,last_error")
      .order("updated_at", { ascending: false }),
    supabase
      .from("connection_resources")
      .select("id,resource_type,active")
      .eq("active", true),
    supabase
      .from("project_bindings")
      .select("id,project_id,binding_type")
      .order("created_at", { ascending: false }),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);

  const projectMap = new Map((projects || []).map((project) => [project.id, project]));
  const google = (connections || []).find((connection) => connection.provider === "google");
  const gscCount = (resources || []).filter((resource) => resource.resource_type === "gsc_property").length;
  const ga4Count = (resources || []).filter((resource) => resource.resource_type === "ga4_property").length;
  const gscBindings = (bindings || []).filter((binding) => binding.binding_type === "gsc").length;
  const ga4Bindings = (bindings || []).filter((binding) => binding.binding_type === "ga4").length;
  const failedJobs = (jobs || []).filter((job) => job.status === "failed").length;
  const runningJobs = (jobs || []).filter((job) => ["running", "queued"].includes(job.status)).length;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Operations control</p>
          <h1>Automations & Data Health</h1>
          <p className="muted">
            Manual runs, scheduled jobs, connector health and execution history in one place.
          </p>
        </div>
      </header>

      <section className="healthGrid">
        <article className="healthCard">
          <span>Google connection</span>
          <strong className={statusClass(google?.status || "disconnected")}>
            {google?.status || "disconnected"}
          </strong>
          <small>{google?.external_account || "No connected account"}</small>
        </article>
        <article className="healthCard">
          <span>Discovered resources</span>
          <strong>{gscCount + ga4Count}</strong>
          <small>{gscCount} GSC · {ga4Count} GA4</small>
        </article>
        <article className="healthCard">
          <span>Project bindings</span>
          <strong>{gscBindings + ga4Bindings}</strong>
          <small>{gscBindings} GSC · {ga4Bindings} GA4</small>
        </article>
        <article className="healthCard">
          <span>Running / queued</span>
          <strong>{runningJobs}</strong>
          <small>Current execution queue</small>
        </article>
        <article className="healthCard">
          <span>Failed jobs</span>
          <strong className={failedJobs ? "healthBad" : "healthGood"}>{failedJobs}</strong>
          <small>Last 100 jobs</small>
        </article>
        <article className="healthCard">
          <span>Pending approvals</span>
          <strong>{pendingApprovals || 0}</strong>
          <small>External-impact actions</small>
        </article>
      </section>

      {google?.last_error ? (
        <p className="formMessage formError pageMessage">Google connection: {google.last_error}</p>
      ) : null}

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Job history</h2>
              <p>Manual and future scheduled/condition-triggered executions.</p>
            </div>
          </div>

          {(jobs || []).length ? (
            <div className="dataTableWrap">
              <table className="dataTable jobsTable">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Job</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Completed</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs || []).map((job) => {
                    const project = projectMap.get(job.project_id);
                    const summary = (job.result_summary || {}) as Record<string, unknown>;
                    return (
                      <tr key={job.id}>
                        <td>
                          {project ? (
                            <Link href={`/projects/${project.id}`}><strong>{project.name}</strong></Link>
                          ) : "Unknown"}
                        </td>
                        <td>{job.job_type.replaceAll("_", " ")}</td>
                        <td>{job.trigger_type}</td>
                        <td><span className={`jobStatus job-${job.status}`}>{job.status}</span></td>
                        <td>{formatDate(job.started_at || job.created_at)}</td>
                        <td>{formatDate(job.completed_at)}</td>
                        <td>
                          {summary.candidates !== undefined
                            ? `${String(summary.candidates)} candidates`
                            : summary.error
                              ? String(summary.error)
                              : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState smallEmpty">
              <strong>No jobs yet</strong>
              <span>Run an Opportunity Scan from a project's GSC workspace.</span>
            </div>
          )}
        </section>

        <aside className="sideStack">
          <section className="panel">
            <div className="panelHeader"><div><h2>Google data health</h2><p>Account-level connector state.</p></div></div>
            <div className="healthList">
              <div><span>Connection</span><strong>{google?.status || "disconnected"}</strong></div>
              <div><span>Last discovery</span><strong>{formatDate(google?.last_discovery_at || null)}</strong></div>
              <div><span>GSC resources</span><strong>{gscCount}</strong></div>
              <div><span>GA4 resources</span><strong>{ga4Count}</strong></div>
            </div>
            <Link className="secondaryButton inlineLink" href="/settings">Manage connection</Link>
          </section>

          <section className="panel">
            <div className="panelHeader"><div><h2>Scheduler roadmap</h2><p>Next execution layer.</p></div></div>
            <div className="ruleList">
              <span>Daily GSC incremental sync</span>
              <span>Daily/weekly GA4 SEO sync</span>
              <span>Weekly Opportunity Scan</span>
              <span>Weekly standard rank tracking</span>
              <span>Monthly HTTP crawl</span>
              <span>Condition-based regression alerts</span>
            </div>
            <p className="muted">
              Job history is live now. Persistent background scheduling is the next implementation step.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
