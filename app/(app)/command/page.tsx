import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
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
  const selectedThreadId = scalar(query.thread);
  const supabase = await createClient();

  const [
    { data: threads },
    { data: selectedMessages },
    { data: schedules },
    { data: recentActions },
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
  ]);

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
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Executive control</p>
          <h1>Chief Operator</h1>
          <p className="muted">
            One conversational manager for projects, analytics setup, delegation, reports and scheduled work.
          </p>
        </div>
        <div className="buttonRow">
          <Link href="/team" className="secondaryButton">Open Team Room</Link>
          <Link href="/command" className="primaryButton">New command</Link>
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
              <div><h2>Conversations</h2><p>Recent command threads.</p></div>
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
              <div><h2>Scheduled work</h2><p>{schedules?.length || 0} active or paused tasks.</p></div>
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
