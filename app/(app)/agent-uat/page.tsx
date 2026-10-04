import Link from "next/link";
import { AGENT_UAT_SCENARIOS } from "@/lib/agents/uat-scenarios";
import { createClient } from "@/lib/supabase/server";
import { runAgentUatAction } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function money(value: number | string | null | undefined) {
  const number = Number(value || 0);
  return "$" + number.toFixed(number < 0.01 ? 4 : 2);
}

function statusClass(status: string) {
  if (status === "passed") return "healthGood";
  if (status === "failed" || status === "error") return "healthBad";
  return "";
}

function agentLabel(key: string) {
  const labels: Record<string, string> = {
    seo_lead: "SEO Lead",
    data_analyst: "Data Analyst",
    technical_seo: "Technical SEO",
    research_content: "Research & Content",
    reporting_output: "Reporting / Output",
    developer: "Developer",
    sales_lead: "Sales Lead",
  };
  return labels[key] || key.replaceAll("_", " ");
}

export default async function AgentUatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const supabase = await createClient();

  const { data: projects } = await supabase
    .from("projects")
    .select("id,name,project_type,status")
    .eq("status", "active")
    .order("name");

  const selectedProject =
    scalar(query.project) || projects?.[0]?.id || "";
  const selectedAgent = scalar(query.agent, "all");
  const selectedRunId = scalar(query.run);

  const today = new Date();
  const dayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  ).toISOString();

  const [
    { data: runs },
    { count: todayCount },
    { data: selectedRun },
  ] = selectedProject
    ? await Promise.all([
        supabase
          .from("agent_uat_runs")
          .select("id,project_id,scenario_key,scenario_name,expected_agent_key,actual_agent_key,execution_mode,status,score,checks,agent_run_id,actual_cost,error,started_at,completed_at")
          .eq("project_id", selectedProject)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("agent_uat_runs")
          .select("id", { count: "exact", head: true })
          .eq("project_id", selectedProject)
          .gte("created_at", dayStart),
        selectedRunId
          ? supabase
              .from("agent_uat_runs")
              .select("id,scenario_key,scenario_name,expected_agent_key,actual_agent_key,execution_mode,status,score,checks,agent_run_id,actual_cost,error,started_at,completed_at")
              .eq("id", selectedRunId)
              .eq("project_id", selectedProject)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ])
    : [
        { data: [] },
        { count: 0 },
        { data: null },
      ];

  const scenarios = AGENT_UAT_SCENARIOS.filter((scenario) =>
    selectedAgent === "all"
      ? true
      : scenario.expectedAgentKey === selectedAgent,
  );

  const latestByScenario = new Map(
    (runs || []).map((run) => [run.scenario_key, run]),
  );

  const completed = (runs || []).filter((run) =>
    ["passed", "failed"].includes(run.status),
  );
  const passed = completed.filter((run) => run.status === "passed").length;
  const failed = completed.filter((run) => run.status === "failed").length;
  const averageScore = completed.length
    ? Math.round(
        completed.reduce((sum, run) => sum + Number(run.score || 0), 0) /
          completed.length,
      )
    : null;
  const spent = (runs || []).reduce(
    (sum, run) => sum + Number(run.actual_cost || 0),
    0,
  );
  const dailyRemaining = Math.max(10 - Number(todayCount || 0), 0);
  const apiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const agentKeys = Array.from(
    new Set(AGENT_UAT_SCENARIOS.map((scenario) => scenario.expectedAgentKey)),
  );

  const checks = (selectedRun?.checks || {}) as Record<string, boolean>;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Controlled production validation</p>
          <h1>Agent UAT</h1>
          <p className="muted">
            42 controlled scenarios validate routing, evidence discipline, approval
            gates and handoff behavior. Runs are intentionally one-at-a-time to
            protect model budget.
          </p>
        </div>
        <Link href="/agents" className="secondaryButton">Agent Center</Link>
      </header>

      {scalar(query.error) ? (
        <p className="formMessage formError pageMessage">{scalar(query.error)}</p>
      ) : null}
      {scalar(query.message) ? (
        <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p>
      ) : null}

      <section className="panel">
        <form method="get" className="budgetForm">
          <label>
            Test project
            <select name="project" defaultValue={selectedProject}>
              {(projects || []).map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name} · {project.project_type.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Agent
            <select name="agent" defaultValue={selectedAgent}>
              <option value="all">All agents</option>
              {agentKeys.map((key) => (
                <option value={key} key={key}>{agentLabel(key)}</option>
              ))}
            </select>
          </label>
          <button className="secondaryButton" type="submit">Apply</button>
        </form>
      </section>

      <section className="healthGrid">
        <article className="healthCard">
          <span>Scenario catalog</span>
          <strong>{AGENT_UAT_SCENARIOS.length}</strong>
          <small>35 direct · 7 router</small>
        </article>
        <article className="healthCard">
          <span>Completed</span>
          <strong>{completed.length}</strong>
          <small>{passed} passed · {failed} failed</small>
        </article>
        <article className="healthCard">
          <span>Average score</span>
          <strong>{averageScore === null ? "—" : averageScore + "/100"}</strong>
          <small>Selected project history</small>
        </article>
        <article className="healthCard">
          <span>UAT model spend</span>
          <strong>{money(spent)}</strong>
          <small>Visible project UAT history</small>
        </article>
        <article className="healthCard">
          <span>Runs left today</span>
          <strong className={dailyRemaining ? "healthGood" : "healthBad"}>
            {dailyRemaining}
          </strong>
          <small>10/day project safety cap</small>
        </article>
        <article className="healthCard">
          <span>Model runtime</span>
          <strong className={apiConfigured ? "healthGood" : "healthBad"}>
            {apiConfigured ? "Ready" : "Waiting"}
          </strong>
          <small>OPENAI_API_KEY</small>
        </article>
      </section>

      {!selectedProject ? (
        <section className="panel">
          <div className="emptyState">
            <strong>No active project available</strong>
            <span>Create a project before running Agent UAT.</span>
          </div>
        </section>
      ) : (
        <div className="twoCol dataTwoCol">
          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Controlled scenarios</h2>
                <p>
                  Each click executes exactly one scenario and consumes normal project AI budget.
                </p>
              </div>
            </div>

            <div className="readinessList">
              {scenarios.map((scenario) => {
                const latest = latestByScenario.get(scenario.key);
                return (
                  <div className="readinessRow" key={scenario.key}>
                    <div className="readinessCopy">
                      <strong>{scenario.name}</strong>
                      <span>
                        {agentLabel(scenario.expectedAgentKey)} · {scenario.mode}
                        {latest
                          ? " · latest " + String(latest.score || 0) + "/100"
                          : " · not run"}
                      </span>
                    </div>
                    <div className="readinessRowActions">
                      {latest ? (
                        <Link
                          className="ghostButton"
                          href={
                            "/agent-uat?project=" +
                            encodeURIComponent(selectedProject) +
                            "&agent=" +
                            encodeURIComponent(selectedAgent) +
                            "&run=" +
                            encodeURIComponent(latest.id)
                          }
                        >
                          Inspect
                        </Link>
                      ) : null}
                      <form action={runAgentUatAction}>
                        <input type="hidden" name="projectId" value={selectedProject} />
                        <input type="hidden" name="scenarioKey" value={scenario.key} />
                        <button
                          className="primaryButton"
                          type="submit"
                          disabled={!apiConfigured || dailyRemaining <= 0}
                        >
                          Run test
                        </button>
                      </form>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <aside className="sideStack">
            <section className="panel">
              <div className="panelHeader">
                <div>
                  <h2>Selected UAT result</h2>
                  <p>Deterministic quality checks.</p>
                </div>
              </div>

              {selectedRun ? (
                <div className="agentResult">
                  <div className="agentResultMeta">
                    <span className={statusClass(selectedRun.status)}>
                      {selectedRun.status}
                    </span>
                    <span>{String(selectedRun.score || 0)}/100</span>
                    <span>{money(selectedRun.actual_cost)}</span>
                  </div>

                  <div className="agentResultBlock">
                    <strong>{selectedRun.scenario_name}</strong>
                    <p>
                      Expected {agentLabel(selectedRun.expected_agent_key)} · actual{" "}
                      {selectedRun.actual_agent_key
                        ? agentLabel(selectedRun.actual_agent_key)
                        : "—"}
                    </p>
                  </div>

                  <div className="readinessList">
                    {Object.entries(checks).map(([key, passed]) => (
                      <div className="readinessRow" key={key}>
                        <div className="readinessCopy">
                          <strong>{key.replaceAll("_", " ")}</strong>
                        </div>
                        <div className="readinessRowActions">
                          <span className={passed ? "healthGood" : "healthBad"}>
                            {passed ? "pass" : "fail"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {selectedRun.agent_run_id ? (
                    <Link
                      className="secondaryButton"
                      href={"/agents?run=" + selectedRun.agent_run_id}
                    >
                      Inspect agent run
                    </Link>
                  ) : null}

                  {selectedRun.error ? (
                    <p className="formMessage formError">{selectedRun.error}</p>
                  ) : null}
                </div>
              ) : (
                <div className="emptyState smallEmpty">
                  <span>Run or inspect a scenario to see its quality checks.</span>
                </div>
              )}
            </section>
          </aside>
        </div>
      )}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Recent UAT history</h2>
            <p>Latest 100 runs for the selected project.</p>
          </div>
        </div>
        {(runs || []).length ? (
          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Scenario</th>
                  <th>Expected</th>
                  <th>Actual</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {(runs || []).map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link
                        href={
                          "/agent-uat?project=" +
                          encodeURIComponent(selectedProject) +
                          "&agent=" +
                          encodeURIComponent(selectedAgent) +
                          "&run=" +
                          encodeURIComponent(run.id)
                        }
                      >
                        {new Date(run.started_at).toLocaleString("en-GB")}
                      </Link>
                    </td>
                    <td>{run.scenario_name}</td>
                    <td>{agentLabel(run.expected_agent_key)}</td>
                    <td>{run.actual_agent_key ? agentLabel(run.actual_agent_key) : "—"}</td>
                    <td>{run.execution_mode}</td>
                    <td><span className={statusClass(run.status)}>{run.status}</span></td>
                    <td>{run.score === null ? "—" : String(run.score) + "/100"}</td>
                    <td>{money(run.actual_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No UAT runs for this project yet.</span>
          </div>
        )}
      </section>
    </div>
  );
}
