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
    { data: salesCampaigns },
    { data: salesRuns },
    { data: technicalSchedules },
    { data: rankSettings },
    { data: opportunitySettings },
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
    supabase
      .from("sales_campaigns")
      .select("id,name,status,auto_discovery_enabled,schedule_kind,schedule_config,timezone,auto_qualify_count,last_auto_run_at,last_auto_status,last_auto_error,auto_failure_count")
      .eq("auto_discovery_enabled", true)
      .order("updated_at", { ascending: false }),
    supabase
      .from("sales_discovery_runs")
      .select("id,campaign_id,status,queries_completed,queries_requested,candidates_seen,leads_created,actual_cost,started_at,completed_at,error")
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("technical_crawl_schedules")
      .select("id,project_id,name,crawl_type,max_urls,schedule_kind,schedule_config,timezone,status,last_run_at,last_status,last_error,failure_count")
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(50),
    supabase
      .from("rank_tracking_settings")
      .select("project_id,active,auto_discover_enabled,last_seeded_at,last_worker_run_at")
      .eq("active", true)
      .order("updated_at", { ascending: false }),
    supabase
      .from("opportunity_scan_settings")
      .select("project_id,enabled,scan_gsc,scan_ga4,scan_rank,cadence,last_run_at,last_data_date,last_status,last_error,consecutive_failures")
      .eq("enabled", true)
      .order("updated_at", { ascending: false }),
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
  const salesWorkerReady = Boolean(
    workerReady && process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );
  const automatedSalesCampaigns = salesCampaigns?.length || 0;
  const activeTechnicalSchedules = (technicalSchedules || []).filter((item) =>
    ["active", "running"].includes(item.status),
  ).length;
  const rankWorkerReady = Boolean(
    workerReady && process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );
  const activeRankProjects = rankSettings?.length || 0;
  const activeOpportunityProjects = opportunitySettings?.length || 0;

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
          <span>Sales discovery</span>
          <strong>{automatedSalesCampaigns}</strong>
          <small>{salesWorkerReady ? "Worker ready" : "Worker paused / provider missing"}</small>
        </article>
        <article className="healthCard">
          <span>Technical crawler</span>
          <strong>{activeTechnicalSchedules}</strong>
          <small>{workerReady ? "Deterministic worker ready" : "Worker paused"}</small>
        </article>
        <article className="healthCard">
          <span>Rank tracking</span>
          <strong>{activeRankProjects}</strong>
          <small>{rankWorkerReady ? "Paid SERP worker ready" : "Worker paused / provider missing"}</small>
        </article>
        <article className="healthCard">
          <span>Opportunity Engine</span>
          <strong>{activeOpportunityProjects}</strong>
          <small>{workerReady ? "Warehouse worker ready" : "Worker paused"}</small>
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

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Rank tracking automation</h2>
            <p>Exact SERP checks run only for due keywords and respect project SERP budget hard stops.</p>
          </div>
        </div>
        {(rankSettings || []).length ? (
          <div className="automationTaskList">
            {(rankSettings || []).map((settings) => {
              const project = projectMap.get(settings.project_id);
              return (
                <article className="automationTaskCard" key={settings.project_id}>
                  <div className="automationTaskTop">
                    <div>
                      <p className="eyebrow">{project?.name || "Project"} · rank tracker</p>
                      <h3>{settings.auto_discover_enabled ? "GSC-assisted tracking" : "Manual keyword universe"}</h3>
                    </div>
                    <span className="jobStatus job-active">active</span>
                  </div>
                  <div className="automationTaskMeta">
                    <span>Auto discovery: {settings.auto_discover_enabled ? "on" : "off"}</span>
                    <span>Last seed: {formatDate(settings.last_seeded_at)}</span>
                    <span>Last worker: {formatDate(settings.last_worker_run_at)}</span>
                  </div>
                  {project ? (
                    <div className="buttonRow">
                      <Link className="ghostButton" href={"/projects/" + project.id + "/rank-tracker"}>
                        Open Rank Tracker
                      </Link>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No active project rank-tracking settings.</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Opportunity Engine automation</h2>
            <p>Warehouse GSC/GA4 and rank evidence are compared without using an LLM for data collection.</p>
          </div>
          <Link href="/opportunities" className="secondaryButton">Open Intelligence Inbox</Link>
        </div>
        {(opportunitySettings || []).length ? (
          <div className="automationTaskList">
            {(opportunitySettings || []).map((settings) => {
              const project = projectMap.get(settings.project_id);
              return (
                <article className="automationTaskCard" key={settings.project_id}>
                  <div className="automationTaskTop">
                    <div>
                      <p className="eyebrow">{project?.name || "Project"} · {settings.cadence}</p>
                      <h3>
                        {[
                          settings.scan_gsc ? "GSC" : null,
                          settings.scan_ga4 ? "GA4" : null,
                          settings.scan_rank ? "Rank" : null,
                        ].filter(Boolean).join(" + ")}
                      </h3>
                    </div>
                    <span className={"jobStatus job-" + settings.last_status}>
                      {settings.last_status}
                    </span>
                  </div>
                  <div className="automationTaskMeta">
                    <span>Last run: {formatDate(settings.last_run_at)}</span>
                    <span>Latest data: {settings.last_data_date || "—"}</span>
                    <span>Failures: {settings.consecutive_failures || 0}</span>
                  </div>
                  {settings.last_error ? (
                    <p className="formMessage formError">{settings.last_error}</p>
                  ) : null}
                  {project ? (
                    <div className="buttonRow">
                      <Link className="ghostButton" href={"/opportunities?project=" + project.id}>
                        Open intelligence
                      </Link>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No projects have automatic opportunity scans enabled.</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Technical crawl automation</h2>
            <p>Deterministic site crawling runs independently from AI models.</p>
          </div>
        </div>

        {(technicalSchedules || []).length ? (
          <div className="automationTaskList">
            {(technicalSchedules || []).map((schedule) => {
              const project = projectMap.get(schedule.project_id);
              return (
                <article className="automationTaskCard" key={schedule.id}>
                  <div className="automationTaskTop">
                    <div>
                      <p className="eyebrow">
                        {project?.name || "Project"} · {schedule.crawl_type === "delta" ? "delta monitoring" : "full http crawl"}
                      </p>
                      <h3>{schedule.name}</h3>
                    </div>
                    <span className={"jobStatus job-" + schedule.status}>
                      {schedule.status}
                    </span>
                  </div>
                  <p>
                    {scheduleDescription(
                      schedule.schedule_kind as ScheduleKind,
                      (schedule.schedule_config || {}) as ScheduleConfig,
                      schedule.timezone || "Europe/Istanbul",
                    )}
                  </p>
                  <div className="automationTaskMeta">
                    <span>{schedule.max_urls} URL limit</span>
                    <span>Last run: {formatDate(schedule.last_run_at)}</span>
                    <span>State: {schedule.last_status}</span>
                    <span>Failures: {schedule.failure_count || 0}</span>
                  </div>
                  {schedule.last_error ? (
                    <p className="formMessage formError">{schedule.last_error}</p>
                  ) : null}
                  {project ? (
                    <div className="buttonRow">
                      <Link
                        className="ghostButton"
                        href={"/projects/" + project.id + "/technical"}
                      >
                        Open Technical Audit
                      </Link>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No technical crawl schedules configured.</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Sales discovery automation</h2>
            <p>Deterministic SERP discovery and optional homepage qualification. No outreach is sent automatically.</p>
          </div>
          <Link href="/sales" className="secondaryButton">Open Sales</Link>
        </div>

        {(salesCampaigns || []).length ? (
          <div className="automationTaskList">
            {(salesCampaigns || []).map((campaign) => {
              const latestRun = (salesRuns || []).find((run) => run.campaign_id === campaign.id);
              return (
                <article className="automationTaskCard" key={campaign.id}>
                  <div className="automationTaskTop">
                    <div>
                      <p className="eyebrow">Sales discovery</p>
                      <h3>{campaign.name}</h3>
                    </div>
                    <span className={"jobStatus job-" + campaign.last_auto_status}>
                      {campaign.last_auto_status}
                    </span>
                  </div>
                  <p>
                    {campaign.schedule_kind
                      ? scheduleDescription(
                          campaign.schedule_kind as ScheduleKind,
                          (campaign.schedule_config || {}) as ScheduleConfig,
                          campaign.timezone || "Europe/Istanbul",
                        )
                      : "Schedule missing"}
                  </p>
                  <div className="automationTaskMeta">
                    <span>Auto qualify: {campaign.auto_qualify_count || 0}</span>
                    <span>Last auto run: {formatDate(campaign.last_auto_run_at)}</span>
                    <span>Failures: {campaign.auto_failure_count || 0}</span>
                    {latestRun ? <span>Latest cost: {"$" + Number(latestRun.actual_cost || 0).toFixed(4)}</span> : null}
                  </div>
                  {campaign.last_auto_error ? (
                    <p className="formMessage formError">{campaign.last_auto_error}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No Sales campaigns have background discovery enabled.</span>
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
              <div><span>Sales discovery worker</span><strong>{salesWorkerReady ? "ready to activate" : "paused"}</strong></div>
              <div><span>Technical crawl worker</span><strong>{workerReady ? "ready to activate" : "paused"}</strong></div>
              <div><span>Rank tracker worker</span><strong>{rankWorkerReady ? "ready to activate" : "paused"}</strong></div>
              <div><span>Opportunity Engine worker</span><strong>{workerReady ? "ready to activate" : "paused"}</strong></div>
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
