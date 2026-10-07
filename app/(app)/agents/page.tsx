import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";
import { runAgentAction } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function money(value: number | string | null) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `$${number.toFixed(number < 0.01 ? 4 : 2)}`;
}

function runStatusClass(status: string) {
  if (status === "succeeded") return "agentRunGood";
  if (status === "failed") return "agentRunBad";
  if (status === "running" || status === "queued") return "agentRunWarn";
  return "agentRunNeutral";
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const selectedProject = scalar(query.project);
  const selectedRunId = scalar(query.run);
  const supabase = await createClient();

  const [
    { data: agents },
    { data: projects },
    { data: recentRuns },
    { data: selectedRun },
    { count: proposedHandoffs },
  ] = await Promise.all([
    supabase
      .from("agent_definitions")
      .select("agent_key,name,domain,role_type,description,model_class,default_model,status,capabilities,tool_policy,version")
      .order("status", { ascending: false })
      .order("name"),
    supabase
      .from("projects")
      .select("id,name,domain,project_type,status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("agent_runs")
      .select("id,project_id,agent_key,status,model,task_type,input_tokens,output_tokens,actual_cost,error,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(30),
    selectedRunId
      ? supabase
          .from("agent_runs")
          .select("id,project_id,agent_key,status,model,task_type,user_request,context_manifest,output,response_id,input_tokens,output_tokens,actual_cost,error,created_at,completed_at,parent_run_id")
          .eq("id", selectedRunId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("agent_handoffs")
      .select("id", { count: "exact", head: true })
      .eq("status", "proposed"),
  ]);

  const projectMap = new Map((projects || []).map((project) => [project.id, project]));
  const agentMap = new Map((agents || []).map((agent) => [agent.agent_key, agent]));
  const testingAgents = (agents || []).filter((agent) => agent.status === "testing");
  const activeAgents = (agents || []).filter((agent) => agent.status === "active");
  const plannedAgents = (agents || []).filter((agent) => agent.status === "planned");
  const apiConfigured = Boolean(process.env.OPENAI_API_KEY);

  const selectedOutput = (selectedRun?.output || null) as null | {
    summary?: string;
    importance?: string;
    confidence?: string;
    findings?: Array<{
      title?: string;
      finding_type?: string;
      why_it_matters?: string;
      recommended_action?: string;
      evidence_refs?: string[];
    }>;
    next_actions?: string[];
    handoff?: {
      needed?: boolean;
      to_agent_key?: string | null;
      reason?: string | null;
    };
    selected_agent?: string;
    task_type?: string;
    reason?: string;
    use_strong_model?: boolean;
  };

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "AI orkestrasyon katmanı" : "AI orchestration layer"}</p>
          <h1>{tr ? "Agent Merkezi" : "Agent Center"}</h1>
          <p className="muted">
            {tr ? "İsteğe bağlı agentlar: önce deterministik veri, ardından kompakt Project Brain context; model reasoning yalnızca değer kattığı yerde." : "On-demand agents: deterministic data first, compact Project Brain context second, model reasoning only where it adds value."}
          </p>
        </div>
        <span className={apiConfigured ? "connectionStatus connection-connected" : "connectionStatus connection-error"}>
          {apiConfigured ? (tr ? "OpenAI hazır" : "OpenAI ready") : (tr ? "API key gerekli" : "API key required")}
        </span>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}

      {!apiConfigured ? (
        <section className="panel agentSetupWarning">
          <div>
            <strong>Agent runtime is installed but cannot call a model yet.</strong>
            <span>Add <code>OPENAI_API_KEY</code> to the SignalCore Vercel environment. Do not paste the key into chat or commit it to GitHub.</span>
          </div>
        </section>
      ) : null}

      <section className="agentStats">
        <article><span>{tr ? "Teste hazır" : "Ready for testing"}</span><strong>{testingAgents.length + activeAgents.length}</strong><small>Router + core specialists</small></article>
        <article><span>{tr ? "Planlanan agentlar" : "Planned agents"}</span><strong>{plannedAgents.length}</strong><small>Activated as data/services mature</small></article>
        <article><span>{tr ? "Son çalışmalar" : "Recent runs"}</span><strong>{recentRuns?.length || 0}</strong><small>Latest 30 executions</small></article>
        <article><span>{tr ? "Önerilen handofflar" : "Proposed handoffs"}</span><strong>{proposedHandoffs || 0}</strong><small>Specialist escalation requests</small></article>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{tr ? "Agent çalıştır" : "Run an agent"}</h2>
            <p>
              {tr ? "Auto-route önce düşük maliyetli Routerı kullanır. Direct mode routingi atlayıp seçilen uzmanı çağırır." : "Auto-route uses the cheap Router first. Direct mode skips routing and calls the chosen specialist."}
            </p>
          </div>
        </div>

        <form className="agentRunnerForm" action={runAgentAction}>
          <label>
            Project
            <select name="projectId" defaultValue={selectedProject} required>
              <option value="" disabled>{tr ? "Proje seç" : "Select a project"}</option>
              {(projects || []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.project_type.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>

          <label>
            Agent
            <select name="agentKey" defaultValue="auto">
              <option value="auto">Auto-route via Orchestrator</option>
              {testingAgents
                .filter((agent) => agent.agent_key !== "router_orchestrator")
                .map((agent) => (
                  <option key={agent.agent_key} value={agent.agent_key}>
                    {agent.name} · {agent.default_model}
                  </option>
                ))}
            </select>
          </label>

          <label className="agentTaskField">
            Task
            <textarea
              name="request"
              rows={6}
              required
              placeholder="Example: Review the current GSC opportunity findings, identify the 5 highest-value opportunities, explain why each matters, and tell me what should be checked before we act."
            />
          </label>

          <button className="primaryButton" type="submit" disabled={!apiConfigured}>
            {tr ? "SignalCore Agent çalıştır" : "Run SignalCore Agent"}
          </button>
        </form>
      </section>

      <section className="agentFlow">
        <div className="agentFlowNode routerNode">
          <span>01</span>
          <strong>Router</strong>
          <small>Intent · cost · specialist</small>
        </div>
        <div className="agentFlowArrow">→</div>
        <div className="agentFlowGroup">
          <div className="agentFlowNode"><strong>SEO Lead</strong><small>Strategy & priority</small></div>
          <div className="agentFlowNode"><strong>Data Analyst</strong><small>GSC / GA4 interpretation</small></div>
          <div className="agentFlowNode"><strong>Reporting</strong><small>Approved output</small></div>
        </div>
        <div className="agentFlowArrow">→</div>
        <div className="agentFlowNode outcomeNode">
          <span>03</span>
          <strong>Evidence → Action</strong>
          <small>Findings · handoff · report</small>
        </div>
      </section>

      <section className="agentCards">
        {(agents || []).map((agent) => {
          const capabilities = Array.isArray(agent.capabilities)
            ? agent.capabilities.map(String)
            : [];
          const toolPolicy = (agent.tool_policy || {}) as Record<string, unknown>;
          return (
            <article className={`agentCard agentCard-${agent.status}`} key={agent.agent_key}>
              <div className="agentCardTop">
                <div>
                  <p className="eyebrow">{agent.domain}</p>
                  <h3>{agent.name}</h3>
                </div>
                <span className={`agentStatus agentStatus-${agent.status}`}>{agent.status}</span>
              </div>
              <p>{agent.description}</p>
              <div className="agentMeta">
                <div><span>Model class</span><strong>{agent.model_class}</strong></div>
                <div><span>Default model</span><strong>{agent.default_model || "none"}</strong></div>
                <div><span>Version</span><strong>v{agent.version}</strong></div>
                <div><span>Approval</span><strong>{toolPolicy.approval_required ? "required" : "not required"}</strong></div>
              </div>
              <div className="capabilityTags">
                {capabilities.slice(0, 6).map((capability) => (
                  <span key={capability}>{capability.replaceAll("_", " ")}</span>
                ))}
              </div>
            </article>
          );
        })}
      </section>

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>Recent agent runs</h2><p>Every model execution is auditable.</p></div>
          </div>
          {recentRuns?.length ? (
            <div className="dataTableWrap">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Project</th>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => {
                    const project = projectMap.get(run.project_id);
                    const agent = agentMap.get(run.agent_key);
                    return (
                      <tr key={run.id}>
                        <td>
                          <Link href={`/agents?project=${run.project_id || ""}&run=${run.id}`}>
                            {new Date(run.created_at).toLocaleString("en-GB")}
                          </Link>
                        </td>
                        <td>{project?.name || "—"}</td>
                        <td>{agent?.name || run.agent_key}</td>
                        <td><span className={`agentRunStatus ${runStatusClass(run.status)}`}>{run.status}</span></td>
                        <td>{run.model || "—"}</td>
                        <td>{(run.input_tokens || 0) + (run.output_tokens || 0)}</td>
                        <td>{money(run.actual_cost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState smallEmpty"><strong>No agent runs yet</strong><span>Run the first task above after the API key is configured.</span></div>
          )}
        </section>

        <aside className="sideStack">
          <section className="panel">
            <div className="panelHeader"><div><h2>Selected run</h2><p>Structured model output.</p></div></div>

            {selectedRun ? (
              <div className="agentResult">
                <div className="agentResultMeta">
                  <span className={`agentRunStatus ${runStatusClass(selectedRun.status)}`}>{selectedRun.status}</span>
                  <span>{selectedRun.model || "—"}</span>
                  <span>{money(selectedRun.actual_cost)}</span>
                </div>

                <div className="agentPromptEcho">
                  <strong>Task</strong>
                  <p>{selectedRun.user_request}</p>
                </div>

                {selectedOutput?.summary ? (
                  <div className="agentResultBlock">
                    <strong>Summary</strong>
                    <p>{selectedOutput.summary}</p>
                  </div>
                ) : null}

                {selectedOutput?.selected_agent ? (
                  <div className="agentResultBlock">
                    <strong>Route decision</strong>
                    <p>
                      {selectedOutput.selected_agent} · {selectedOutput.reason}
                    </p>
                  </div>
                ) : null}

                {selectedOutput?.findings?.length ? (
                  <div className="agentResultBlock">
                    <strong>Findings</strong>
                    <div className="agentFindingList">
                      {selectedOutput.findings.map((finding, index) => (
                        <div key={index}>
                          <span>{finding.finding_type}</span>
                          <strong>{finding.title}</strong>
                          <p>{finding.why_it_matters}</p>
                          <small>{finding.recommended_action}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {selectedOutput?.next_actions?.length ? (
                  <div className="agentResultBlock">
                    <strong>Next actions</strong>
                    <ol>
                      {selectedOutput.next_actions.map((action, index) => <li key={index}>{action}</li>)}
                    </ol>
                  </div>
                ) : null}

                {selectedOutput?.handoff?.needed ? (
                  <div className="agentHandoffBox">
                    <strong>Handoff proposed</strong>
                    <span>{selectedOutput.handoff.to_agent_key}</span>
                    <p>{selectedOutput.handoff.reason}</p>
                  </div>
                ) : null}

                {selectedRun.error ? <p className="formMessage formError">{selectedRun.error}</p> : null}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>Select a run from the table to inspect its result.</span></div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
