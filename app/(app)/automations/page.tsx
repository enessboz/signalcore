import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { scheduleDescription, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import { setScheduledTaskStatus } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;
function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB");
}

function statusClass(status: string) {
  if (status === "succeeded" || status === "connected" || status === "active") return "healthGood";
  if (status === "failed" || status === "error" || status === "revoked") return "healthBad";
  if (status === "running" || status === "queued" || status === "connecting") return "healthWarn";
  return "healthNeutral";
}

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const supabase = await createClient();

  const [
    { data: projects },
    { data: jobs },
    { data: connections },
    { data: resources },
    { data: bindings },
    { count: pendingApprovals },
    { data: scheduledTasks },
    { data: syncStates },
    { data: syncQueue },
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
      .select("id,project_id,binding_type,auto_sync_enabled")
      .order("created_at", { ascending: false }),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("scheduled_tasks")
      .select("id,project_id,title,instruction,target_agent_key,schedule_kind,schedule_config,post_run_config,timezone,status,last_run_at,next_run_at,failure_count,last_error,created_at")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("google_sync_states")
      .select("project_id,source,dataset,status,last_complete_date,last_success_at,rows_total,last_error,updated_at")
      .order("updated_at", { ascending: false }),
    supabase
      .from("google_sync_queue")
      .select("id,project_id,source,mode,start_date,end_date,cursor_date,status,result,error,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  const projectMap = new Map((projects || []).map((project) => [project.id, project]));
  const google = (connections || []).find((connection) => connection.provider === "google");
  const gscCount = (resources || []).filter((resource) => resource.resource_type === "gsc_property").length;
  const ga4Count = (resources || []).filter((resource) => resource.resource_type === "ga4_property").length;
  const gscBindings = (bindings || []).filter((binding) => binding.binding_type === "gsc").length;
  const ga4Bindings = (bindings || []).filter((binding) => binding.binding_type === "ga4").length;
  const autoSyncBindings = (bindings || []).filter((binding) => binding.auto_sync_enabled).length;
  const failedJobs = (jobs || []).filter((job) => job.status === "failed").length;
  const runningJobs = (jobs || []).filter((job) => ["running", "queued"].includes(job.status)).length;
  const activeScheduled = (scheduledTasks || []).filter((task) => ["active","running"].includes(task.status)).length;
  const queuedSync = (syncQueue || []).filter((job) => ["queued","running"].includes(job.status)).length;
  const workerReady = Boolean(process.env.SUPABASE_SECRET_KEY && process.env.CRON_SECRET);
  const agentReady = Boolean(process.env.OPENAI_API_KEY && workerReady);

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Operations control</p>
          <h1>Automations & Data Health</h1>
          <p className="muted">
            Scheduled agent work, conditional chains, Google warehouse sync and execution health.
          </p>
        </div>
        <Link href="/command" className="primaryButton">Schedule via Chief Operator</Link>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}

      <section className="healthGrid">
        <article className="healthCard">
          <span>Google connection</span>
          <strong className={statusClass(google?.status || "disconnected")}>{google?.status || "disconnected"}</strong>
          <small>{gscCount} GSC · {ga4Count} GA4 resources</small>
        </article>
        <article className="healthCard">
          <span>Auto-sync bindings</span>
          <strong>{autoSyncBindings}</strong>
          <small>{gscBindings + ga4Bindings} total project bindings</small>
        </article>
        <article className="healthCard">
          <span>Scheduled agent work</span>
          <strong>{activeScheduled}</strong>
          <small>{agentReady ? "Worker ready" : "Worker paused / credentials missing"}</small>
        </article>
        <article className="healthCard">
          <span>Google sync queue</span>
          <strong>{queuedSync}</strong>
          <small>{workerReady ? "Worker credentials ready" : "Background sync paused"}</small>
        </article>
        <article className="healthCard">
          <span>Running / queued jobs</span>
          <strong>{runningJobs}</strong>
          <small>Manual execution queue</small>
        </article>
        <article className="healthCard">
          <span>Pending approvals</span>
          <strong>{pendingApprovals || 0}</strong>
          <small>External-impact actions</small>
        </article>
      </section>

      {!workerReady ? (
        <p className="formMessage formError pageMessage">
          Background workers are intentionally paused until SUPABASE_SECRET_KEY is configured.
          Agent schedules additionally require OPENAI_API_KEY.
        </p>
      ) : null}
      {google?.last_error ? (
        <p className="formMessage formError pageMessage">Google connection: {google.last_error}</p>
      ) : null}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Scheduled agent work</h2>
            <p>Recurring and one-time jobs created from Chief Operator or future workflow builders.</p>
          </div>
        </div>

        {(scheduledTasks || []).length ? (
          <div className="automationTaskList">
            {(scheduledTasks || []).map((task) => {
              const project = projectMap.get(task.project_id);
              const postRun = (task.post_run_config || {}) as {
                report_on_importance?: boolean;
                minimum_importance?: string;
                report_format?: string;
              };
              return (
                <article className="automationTaskCard" key={task.id}>
                  <div className="automationTaskTop">
                    <div>
                      <p className="eyebrow">{project?.name || "Project"} · {task.target_agent_key.replaceAll("_"," ")}</p>
                      <h3>{task.title}</h3>
                    </div>
                    <span className={`jobStatus job-${task.status}`}>{task.status}</span>
                  </div>
                  <p>{task.instruction}</p>
                  <div className="automationTaskMeta">
                    <span>{scheduleDescription(
                      task.schedule_kind as ScheduleKind,
                      (task.schedule_config || {}) as ScheduleConfig,
                      task.timezone,
                    )}</span>
                    <span>Last run: {formatDate(task.last_run_at)}</span>
                    <span>Failures: {task.failure_count}</span>
                  </div>
                  {postRun.report_on_importance ? (
                    <div className="automationChain">
                      <strong>Conditional chain</strong>
                      <span>
                        If importance ≥ {postRun.minimum_importance || "high"} → create {postRun.report_format || "summary"} with Reporting Agent
                      </span>
                    </div>
                  ) : null}
                  {task.last_error ? <p className="formMessage formError">{task.last_error}</p> : null}
                  <div className="buttonRow">
                    {task.status === "active" ? (
                      <form action={setScheduledTaskStatus.bind(null, task.id, "paused")}>
                        <button className="secondaryButton" type="submit">Pause</button>
                      </form>
                    ) : task.status === "paused" ? (
                      <form action={setScheduledTaskStatus.bind(null, task.id, "active")}>
                        <button className="secondaryButton" type="submit">Resume</button>
                      </form>
                    ) : null}
                    {!["cancelled","completed"].includes(task.status) ? (
                      <form action={setScheduledTaskStatus.bind(null, task.id, "cancelled")}>
                        <button className="ghostButton" type="submit">Cancel</button>
                      </form>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <strong>No scheduled agent tasks yet</strong>
            <span>Ask Chief Operator to create a one-time, daily, weekly or monthly task.</span>
          </div>
        )}
      </section>

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Google warehouse queue</h2>
              <p>Backfills and incremental GSC/GA4 sync are processed one day at a time.</p>
            </div>
          </div>
          {(syncQueue || []).length ? (
            <div className="dataTableWrap">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>Project</th><th>Source</th><th>Mode</th><th>Period</th><th>Cursor</th><th>Status</th><th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {(syncQueue || []).map((job) => (
                    <tr key={job.id}>
                      <td>{projectMap.get(job.project_id)?.name || "Project"}</td>
                      <td>{job.source.toUpperCase()}</td>
                      <td>{job.mode}</td>
                      <td>{job.start_date} → {job.end_date}</td>
                      <td>{job.cursor_date || "—"}</td>
                      <td><span className={`jobStatus job-${job.status}`}>{job.status}</span></td>
                      <td><span className="cellEllipsis">{job.error || "—"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState smallEmpty"><span>No Google warehouse jobs yet.</span></div>
          )}
        </section>

        <aside className="sideStack">
          <section className="panel">
            <div className="panelHeader"><div><h2>Warehouse state</h2><p>Last complete date per stored dataset.</p></div></div>
            {(syncStates || []).length ? (
              <div className="healthList">
                {(syncStates || []).map((state, index) => (
                  <div key={index}>
                    <span>{projectMap.get(state.project_id)?.name || "Project"} · {state.source.toUpperCase()} · {state.dataset.replaceAll("_"," ")}</span>
                    <strong>{state.last_complete_date || state.status}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>No warehouse data synced yet.</span></div>
            )}
          </section>

          <section className="panel">
            <div className="panelHeader"><div><h2>Runtime state</h2><p>Background services remain explicit.</p></div></div>
            <div className="healthList">
              <div><span>Google connection</span><strong>{google?.status || "disconnected"}</strong></div>
              <div><span>Agent scheduler</span><strong>{agentReady ? "ready to activate" : "paused"}</strong></div>
              <div><span>Data sync worker</span><strong>{workerReady ? "ready to activate" : "paused"}</strong></div>
              <div><span>Failed manual jobs</span><strong>{failedJobs}</strong></div>
            </div>
            <div className="buttonRow">
              <Link className="secondaryButton" href="/readiness">System Readiness</Link>
              <Link className="ghostButton" href="/settings">Connections</Link>
            </div>
          </section>
        </aside>
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div><h2>Manual job history</h2><p>Deterministic scans and non-agent jobs.</p></div>
        </div>
        {(jobs || []).length ? (
          <div className="dataTableWrap">
            <table className="dataTable jobsTable">
              <thead>
                <tr><th>Project</th><th>Job</th><th>Trigger</th><th>Status</th><th>Started</th><th>Completed</th><th>Result</th></tr>
              </thead>
              <tbody>
                {(jobs || []).map((job) => {
                  const project = projectMap.get(job.project_id);
                  const summary = (job.result_summary || {}) as Record<string, unknown>;
                  return (
                    <tr key={job.id}>
                      <td>{project ? <Link href={`/projects/${project.id}`}><strong>{project.name}</strong></Link> : "Unknown"}</td>
                      <td>{job.job_type.replaceAll("_"," ")}</td>
                      <td>{job.trigger_type}</td>
                      <td><span className={`jobStatus job-${job.status}`}>{job.status}</span></td>
                      <td>{formatDate(job.started_at || job.created_at)}</td>
                      <td>{formatDate(job.completed_at)}</td>
                      <td>{summary.candidates !== undefined ? `${String(summary.candidates)} candidates` : summary.error ? String(summary.error) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="emptyState smallEmpty"><span>No manual jobs yet.</span></div>}
      </section>
    </div>
  );
}
