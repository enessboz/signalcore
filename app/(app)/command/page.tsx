import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";
import { scheduleDescription, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import { sendChiefCommand } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

export default async function CommandPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const selectedThreadId = scalar(query.thread);
  const supabase = await createClient();

  const [
    { data: threads },
    { data: selectedMessages },
    { data: schedules },
    { data: recentActions },
    { data: selectedPlans },
  ] = await Promise.all([
    supabase
      .from("command_threads")
      .select("id,title,status,updated_at")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(20),
    selectedThreadId
      ? supabase
          .from("command_messages")
          .select("id,role,content,metadata,created_at")
          .eq("thread_id", selectedThreadId)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    supabase
      .from("scheduled_tasks")
      .select("id,title,project_id,target_agent_key,schedule_kind,schedule_config,timezone,status,last_run_at,next_run_at")
      .in("status", ["active", "paused", "running"])
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("command_actions")
      .select("id,action_type,status,target_agent_key,project_id,created_at,result")
      .order("created_at", { ascending: false })
      .limit(10),
    selectedThreadId
      ? supabase
          .from("command_plans")
          .select("id,title,objective,status,current_step,total_steps,last_error,created_at,updated_at")
          .eq("thread_id", selectedThreadId)
          .order("created_at", { ascending: false })
          .limit(3)
      : Promise.resolve({ data: [] }),
  ]);

  const latestPlan = selectedPlans?.[0] || null;
  const { data: planSteps } = latestPlan
    ? await supabase
        .from("command_plan_steps")
        .select("id,sequence,title,action_type,status,blocker_type,blocker_message,result,updated_at")
        .eq("plan_id", latestPlan.id)
        .order("sequence")
    : { data: [] };

  const apiConfigured = Boolean(process.env.OPENAI_API_KEY);

  const quickPrompts = [
    "Create a client project for example.com and call it Example Client.",
    "For EatBetter, create a funnel: session_start → store_click → purchase.",
    "Every Monday at 09:30, ask the SEO Lead to review new GSC opportunities for EatBetter.",
    "Review the current highest-priority opportunities and prepare an executive summary.",
    "Run a 50-page public prospect audit for the Lead Prospect and ask Sales Lead for the strongest saleable findings.",
  ];

  return (
    <div className="page commandPage">
      <AutoRefresh intervalMs={15000} />
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "Yönetici kontrolü" : "Executive control"}</p>
          <h1>Chief Operator</h1>
          <p className="muted">
            {tr ? "Projeler, analytics kurulumu, delegasyon, raporlar ve zamanlanmış işler için tek konuşmalı yönetici." : "One conversational manager for projects, analytics setup, delegation, reports and scheduled work."}
          </p>
        </div>
        <div className="buttonRow">
          <Link href="/team" className="secondaryButton">{tr ? "Ekip Odasını aç" : "Open Team Room"}</Link>
          <Link href="/command" className="primaryButton">{tr ? "Yeni komut" : "New command"}</Link>
        </div>
      </header>

      {!apiConfigured ? (
        <p className="formMessage formError pageMessage">
          Chief Operator runtime is installed, but OPENAI_API_KEY is not configured yet.
        </p>
      ) : null}
      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}

      <div className="commandLayout">
        <aside className="commandSidebar">
          <section className="panel commandThreadsPanel">
            <div className="panelHeader">
              <div><h2>{tr ? "Konuşmalar" : "Conversations"}</h2><p>{tr ? "Son command threadleri." : "Recent command threads."}</p></div>
            </div>

            <div className="commandThreadList">
              {(threads || []).length ? (
                (threads || []).map((thread) => (
                  <Link
                    href={`/command?thread=${thread.id}`}
                    className={selectedThreadId === thread.id ? "commandThread active" : "commandThread"}
                    key={thread.id}
                  >
                    <strong>{thread.title}</strong>
                    <span>{new Date(thread.updated_at).toLocaleString("en-GB")}</span>
                  </Link>
                ))
              ) : (
                <div className="emptyState smallEmpty"><span>No command threads yet.</span></div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div><h2>{tr ? "Zamanlanmış işler" : "Scheduled work"}</h2><p>{schedules?.length || 0} active or paused tasks.</p></div>
            </div>
            <div className="commandScheduleList">
              {(schedules || []).length ? (
                (schedules || []).map((schedule) => (
                  <div className="commandScheduleRow" key={schedule.id}>
                    <div>
                      <strong>{schedule.title}</strong>
                      <span>
                        {scheduleDescription(
                          schedule.schedule_kind as ScheduleKind,
                          (schedule.schedule_config || {}) as ScheduleConfig,
                          schedule.timezone,
                        )}
                      </span>
                    </div>
                    <small>{schedule.status}</small>
                  </div>
                ))
              ) : (
                <div className="emptyState smallEmpty"><span>No scheduled tasks yet.</span></div>
              )}
            </div>
          </section>
        </aside>

        <main className="commandMain">
          <section className="panel commandChat">
            <div className="commandChatHeader">
              <div className="chiefAvatar">CO</div>
              <div>
                <strong>Chief Operator</strong>
                <span>{apiConfigured ? "Ready to coordinate SignalCore" : "Waiting for API key"}</span>
              </div>
            </div>

            <div className="commandMessages">
              {selectedThreadId && selectedMessages?.length ? (
                selectedMessages.map((message) => (
                  <article
                    key={message.id}
                    className={message.role === "user" ? "commandMessage userMessage" : "commandMessage assistantMessage"}
                  >
                    <div className="commandMessageMeta">
                      <strong>{message.role === "user" ? "You" : "Chief Operator"}</strong>
                      <span>{new Date(message.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <p>{message.content}</p>
                  </article>
                ))
              ) : (
                <div className="commandWelcome">
                  <div className="chiefAvatar large">CO</div>
                  <h2>Tell me what SignalCore should do.</h2>
                  <p>
                    You do not need to create a project first or navigate to a specific analytics screen.
                    I can create internal workspaces, configure funnels, delegate specialists, request reports and schedule recurring work.
                  </p>

                  <div className="quickPromptGrid">
                    {quickPrompts.map((prompt) => (
                      <div className="quickPromptCard" key={prompt}>{prompt}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <form className="commandComposer" action={sendChiefCommand}>
              <input type="hidden" name="threadId" value={selectedThreadId} />
              <textarea
                name="message"
                rows={4}
                required
                placeholder="Example: EatBetter için her pazartesi 09:30'da GSC fırsatlarını SEO Lead'e incelet ve yüksek öncelikli yeni bir şey bulursa rapor hazırla."
              />
              <div className="commandComposerFoot">
                <span>
                  Internal configuration actions can run automatically. External-impact actions require approval.
                </span>
                <button className="primaryButton" type="submit" disabled={!apiConfigured}>
                  Send to Chief Operator
                </button>
              </div>
            </form>
          </section>

          {latestPlan ? (
            <section className="panel commandPlanPanel">
              <div className="panelHeader">
                <div>
                  <h2>{tr ? "Aktif iş planı" : "Current work plan"}</h2>
                  <p>{latestPlan.title}</p>
                </div>
                <span className={"commandPlanState commandPlanState-" + latestPlan.status}>
                  {latestPlan.status.replaceAll("_", " ")}
                </span>
              </div>

              <div className="commandPlanProgress">
                <div>
                  <strong>
                    {Math.min(
                      (planSteps || []).filter((step) =>
                        ["completed", "skipped"].includes(step.status),
                      ).length,
                      latestPlan.total_steps,
                    )}
                    /{latestPlan.total_steps}
                  </strong>
                  <span>{tr ? "step tamamlandı" : "steps completed"}</span>
                </div>
                <div className="commandPlanBar">
                  <span
                    style={{
                      width:
                        (latestPlan.total_steps
                          ? ((planSteps || []).filter((step) =>
                              ["completed", "skipped"].includes(step.status),
                            ).length /
                            latestPlan.total_steps) *
                            100
                          : 0) + "%",
                    }}
                  />
                </div>
              </div>

              <div className="commandPlanSteps">
                {(planSteps || []).map((step) => (
                  <div
                    className={"commandPlanStep commandPlanStep-" + step.status}
                    key={step.id}
                  >
                    <div className="commandPlanStepIndex">
                      {["completed", "skipped"].includes(step.status)
                        ? "✓"
                        : step.sequence}
                    </div>
                    <div className="commandPlanStepCopy">
                      <div>
                        <strong>{step.title}</strong>
                        <span>{step.status.replaceAll("_", " ")}</span>
                      </div>
                      {step.blocker_message ? (
                        <p>{step.blocker_message}</p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>

              {latestPlan.last_error ? (
                <div className="commandPlanBlocker">
                  <strong>
                    {latestPlan.status === "waiting_user"
                      ? tr
                        ? "Senden bilgi bekliyor"
                        : "Waiting for your input"
                      : latestPlan.status === "waiting_data"
                        ? tr
                          ? "Veri hazırlanıyor"
                          : "Preparing required data"
                        : latestPlan.status === "blocked_tool"
                          ? tr
                            ? "Tool problemi"
                            : "Tool dependency"
                          : tr
                            ? "Plan durdu"
                            : "Plan stopped"}
                  </strong>
                  <span>{latestPlan.last_error}</span>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="panel">
            <div className="panelHeader">
              <div><h2>Recent executive actions</h2><p>Audit trail of what the Chief Operator changed or delegated.</p></div>
            </div>

            {(recentActions || []).length ? (
              <div className="commandActionList">
                {(recentActions || []).map((action) => (
                  <div className="commandActionRow" key={action.id}>
                    <div>
                      <strong>{action.action_type.replaceAll("_", " ")}</strong>
                      <span>{action.target_agent_key || "internal action"}</span>
                    </div>
                    <div>
                      <small>{new Date(action.created_at).toLocaleString("en-GB")}</small>
                      <span className={`commandActionStatus commandAction-${action.status}`}>{action.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>No executive actions yet.</span></div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
