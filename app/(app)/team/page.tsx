import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { createClient } from "@/lib/supabase/server";

type AgentDefinitionRow = {
  agent_key: string;
  name: string;
  domain: string;
  description: string;
  model_class: string;
  default_model: string | null;
  status: string;
  reports_to: string | null;
  team_level: number;
  sort_order: number;
  capabilities: unknown;
};

type AgentRunRow = {
  id: string;
  agent_key: string;
  project_id: string | null;
  status: string;
  user_request: string;
  model: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

function runtimeState(run: AgentRunRow | undefined) {
  if (!run) return { label: "Idle", className: "teamIdle" };
  if (run.status === "running" || run.status === "queued") {
    return { label: "Working", className: "teamWorking" };
  }
  if (run.status === "failed") {
    return { label: "Needs attention", className: "teamAttention" };
  }
  return { label: "Idle", className: "teamIdle" };
}

function shortTask(value: string | null | undefined) {
  if (!value) return "No work assigned yet.";
  return value.length > 105 ? `${value.slice(0, 102)}…` : value;
}

export default async function TeamPage() {
  const supabase = await createClient();

  const [
    { data: agents },
    { data: runs },
    { data: schedules },
    { data: handoffs },
    { data: actions },
  ] = await Promise.all([
    supabase
      .from("agent_definitions")
      .select("agent_key,name,domain,description,model_class,default_model,status,reports_to,team_level,sort_order,capabilities")
      .order("sort_order"),
    supabase
      .from("agent_runs")
      .select("id,agent_key,project_id,status,user_request,model,error,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(120),
    supabase
      .from("scheduled_tasks")
      .select("id,title,project_id,target_agent_key,status,schedule_kind,schedule_config,timezone,last_run_at,next_run_at")
      .in("status", ["active", "paused", "running"])
      .order("created_at", { ascending: false }),
    supabase
      .from("agent_handoffs")
      .select("id,from_run_id,to_agent_key,reason,status,created_at")
      .in("status", ["proposed", "accepted"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("command_actions")
      .select("id,action_type,status,target_agent_key,created_at,result")
      .order("created_at", { ascending: false })
      .limit(16),
  ]);

  const typedAgents = (agents || []) as AgentDefinitionRow[];
  const typedRuns = (runs || []) as AgentRunRow[];

  const latestRunByAgent = new Map<string, AgentRunRow>();
  for (const run of typedRuns) {
    if (!latestRunByAgent.has(run.agent_key)) latestRunByAgent.set(run.agent_key, run);
  }

  const schedulesByAgent = new Map<string, number>();
  for (const schedule of schedules || []) {
    schedulesByAgent.set(
      schedule.target_agent_key,
      (schedulesByAgent.get(schedule.target_agent_key) || 0) + 1,
    );
  }

  const chief = typedAgents.find((agent) => agent.agent_key === "chief_operator");
  const router = typedAgents.find((agent) => agent.agent_key === "router_orchestrator");
  const specialists = typedAgents.filter((agent) => agent.team_level === 2);

  function AgentCard({
    agent,
    featured = false,
  }: {
    agent: AgentDefinitionRow;
    featured?: boolean;
  }) {
    const latest = latestRunByAgent.get(agent.agent_key);
    const state = runtimeState(latest);
    const scheduledCount = schedulesByAgent.get(agent.agent_key) || 0;
    const capabilities = Array.isArray(agent.capabilities)
      ? agent.capabilities.map(String)
      : [];

    return (
      <article className={featured ? "teamAgentCard featured" : "teamAgentCard"}>
        <div className="teamAgentHeader">
          <div className="teamAgentIdentity">
            <div className="teamAgentAvatar">{agent.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div>
            <div>
              <p className="eyebrow">{agent.domain}</p>
              <h3>{agent.name}</h3>
            </div>
          </div>
          <span className={`teamRuntime ${state.className}`}>{state.label}</span>
        </div>

        <p className="teamAgentDescription">{agent.description}</p>

        <div className="teamAgentTask">
          <span>{latest?.status === "running" ? "Working on" : "Last task"}</span>
          <strong>{shortTask(latest?.user_request)}</strong>
          <small>
            {latest
              ? `${latest.model || agent.default_model || "model not set"} · ${new Date(latest.created_at).toLocaleString("en-GB")}`
              : agent.default_model || "Model not set"}
          </small>
        </div>

        <div className="teamAgentFooter">
          <div><span>Install</span><strong>{agent.status}</strong></div>
          <div><span>Scheduled</span><strong>{scheduledCount}</strong></div>
          <div><span>Model class</span><strong>{agent.model_class}</strong></div>
        </div>

        {capabilities.length ? (
          <div className="teamCapabilityLine">
            {capabilities.slice(0, 4).map((capability) => (
              <span key={capability}>{capability.replaceAll("_", " ")}</span>
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <div className="page teamPage">
      <AutoRefresh intervalMs={12000} />
      <header className="pageHeader">
        <div>
          <p className="eyebrow">AI organization</p>
          <h1>Team Room</h1>
          <p className="muted">
            Live hierarchy, runtime state, assigned work, handoffs and scheduled responsibilities.
          </p>
        </div>
        <div className="buttonRow">
          <Link href="/command" className="primaryButton">Talk to Chief Operator</Link>
          <Link href="/agents" className="secondaryButton">Agent Center</Link>
        </div>
      </header>

      <section className="teamLegend">
        <div><span className="legendDot working" /> Working</div>
        <div><span className="legendDot idle" /> Idle</div>
        <div><span className="legendDot attention" /> Needs attention</div>
        <div><strong>{schedules?.length || 0}</strong> scheduled tasks</div>
        <div><strong>{handoffs?.length || 0}</strong> open handoffs</div>
      </section>

      <section className="orgChart">
        {chief ? (
          <div className="orgLevel orgChief">
            <AgentCard agent={chief} featured />
          </div>
        ) : null}

        <div className="orgConnector vertical" />

        {router ? (
          <div className="orgLevel orgRouter">
            <AgentCard agent={router} featured />
          </div>
        ) : null}

        <div className="orgConnector vertical" />

        <div className="orgSpecialistWrap">
          <div className="orgHorizontalLine" />
          <div className="orgSpecialistGrid">
            {specialists.map((agent) => (
              <div className="orgSpecialistNode" key={agent.agent_key}>
                <div className="orgNodeStem" />
                <AgentCard agent={agent} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="twoCol dataTwoCol teamLowerGrid">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>Current & recent activity</h2><p>Latest agent executions across the organization.</p></div>
          </div>
          {(runs || []).length ? (
            <div className="teamActivityList">
              {typedRuns.slice(0, 18).map((run) => {
                const agent = typedAgents.find((item) => item.agent_key === run.agent_key);
                const state = runtimeState(run);
                return (
                  <div className="teamActivityRow" key={run.id}>
                    <div className="activityAgentBadge">{agent?.name?.slice(0, 2).toUpperCase() || "AI"}</div>
                    <div className="teamActivityCopy">
                      <strong>{agent?.name || run.agent_key}</strong>
                      <span>{shortTask(run.user_request)}</span>
                    </div>
                    <div className="teamActivityMeta">
                      <span className={`teamRuntime ${state.className}`}>{run.status}</span>
                      <small>{new Date(run.created_at).toLocaleString("en-GB")}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="emptyState smallEmpty"><span>No agent activity yet.</span></div>
          )}
        </section>

        <aside className="sideStack">
          <section className="panel">
            <div className="panelHeader"><div><h2>Open handoffs</h2><p>Work waiting to move between specialists.</p></div></div>
            {(handoffs || []).length ? (
              <div className="teamHandoffList">
                {(handoffs || []).map((handoff) => (
                  <div className="teamHandoffRow" key={handoff.id}>
                    <strong>→ {handoff.to_agent_key.replaceAll("_", " ")}</strong>
                    <p>{handoff.reason}</p>
                    <span>{handoff.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>No open handoffs.</span></div>
            )}
          </section>

          <section className="panel">
            <div className="panelHeader"><div><h2>Executive activity</h2><p>Recent Chief Operator actions.</p></div></div>
            {(actions || []).length ? (
              <div className="teamExecutiveList">
                {(actions || []).map((action) => (
                  <div className="teamExecutiveRow" key={action.id}>
                    <div>
                      <strong>{action.action_type.replaceAll("_", " ")}</strong>
                      <span>{action.target_agent_key || "internal"}</span>
                    </div>
                    <small>{action.status}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>No executive actions yet.</span></div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
