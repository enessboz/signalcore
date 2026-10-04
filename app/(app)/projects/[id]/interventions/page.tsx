import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { createClient } from "@/lib/supabase/server";
import {
  cancelSeoIntervention,
  createSeoIntervention,
  evaluateSeoInterventionCheck,
} from "./actions";

type SearchParams = {
  error?: string;
  message?: string;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value + (value.length === 10 ? "T00:00:00Z" : "")).toLocaleDateString(
    "en-GB",
  );
}

function checkpointLabel(status: string, resultClass: string | null) {
  if (status === "evaluated" && resultClass) return resultClass.replace("_", " ");
  if (resultClass === "insufficient_data") return "waiting for data";
  return status;
}

export default async function InterventionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,domain,project_type")
    .eq("id", id)
    .single();

  if (!project) notFound();

  const [
    { data: interventions },
    { data: urls },
    { data: queries },
    { data: checks },
    { data: coverageData },
  ] = await Promise.all([
    supabase
      .from("seo_interventions")
      .select(
        "id,title,intervention_type,implemented_at,hypothesis,notes,scope_mode,status,created_at",
      )
      .eq("project_id", id)
      .order("implemented_at", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("seo_intervention_urls")
      .select("id,intervention_id,url,url_path")
      .eq("project_id", id)
      .order("created_at"),
    supabase
      .from("seo_intervention_queries")
      .select("id,intervention_id,query")
      .eq("project_id", id)
      .order("created_at"),
    supabase
      .from("seo_intervention_checks")
      .select(
        "id,intervention_id,checkpoint_days,due_date,status,result_class,summary,evaluated_at,last_attempt_at,last_error",
      )
      .eq("project_id", id)
      .order("checkpoint_days"),
    supabase.rpc("get_warehouse_coverage", {
      p_project_id: id,
      p_days: 28,
    }),
  ]);

  const urlMap = new Map<string, typeof urls>();
  for (const row of urls || []) {
    const group = urlMap.get(row.intervention_id) || [];
    group.push(row);
    urlMap.set(row.intervention_id, group);
  }

  const queryMap = new Map<string, typeof queries>();
  for (const row of queries || []) {
    const group = queryMap.get(row.intervention_id) || [];
    group.push(row);
    queryMap.set(row.intervention_id, group);
  }

  const checkMap = new Map<string, typeof checks>();
  for (const row of checks || []) {
    const group = checkMap.get(row.intervention_id) || [];
    group.push(row);
    checkMap.set(row.intervention_id, group);
  }

  const coverage =
    (coverageData || {}) as Record<string, Record<string, unknown>>;
  const gscCoverage = coverage.gsc || {};
  const ga4Coverage = coverage.ga4 || {};
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">SEO measurement</p>
          <h1>Intervention Monitoring</h1>
          <p className="muted">
            Record SEO changes once, then compare first-party GSC and GA4 movement at
            D+7, D+14 and D+28 without claiming causality.
          </p>
        </div>
      </header>

      <ProjectDataNav projectId={id} active="interventions" />

      {query.error ? (
        <p className="formMessage formError pageMessage">{query.error}</p>
      ) : null}
      {query.message ? (
        <p className="formMessage formSuccess pageMessage">{query.message}</p>
      ) : null}

      <section className="healthGrid">
        <article className="healthCard">
          <span>GSC warehouse coverage</span>
          <strong>{String(gscCoverage.current_days || 0)}/28</strong>
          <small>
            Previous period: {String(gscCoverage.previous_days || 0)}/28 days
          </small>
        </article>
        <article className="healthCard">
          <span>GA4 warehouse coverage</span>
          <strong>{String(ga4Coverage.current_days || 0)}/28</strong>
          <small>
            Previous period: {String(ga4Coverage.previous_days || 0)}/28 days
          </small>
        </article>
        <article className="healthCard">
          <span>Monitoring interventions</span>
          <strong>
            {(interventions || []).filter((item) => item.status === "monitoring").length}
          </strong>
          <small>{(interventions || []).length} recorded interventions</small>
        </article>
      </section>

      <div className="twoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Record SEO intervention</h2>
              <p>
                Save what changed, where it changed and what you expected to happen.
              </p>
            </div>
          </div>

          <form
            className="formPanel"
            action={createSeoIntervention.bind(null, id)}
          >
            <label>
              Intervention title
              <input
                name="title"
                placeholder="e.g. Reworked protein cluster internal linking"
                required
              />
            </label>

            <label>
              Change type
              <select name="interventionType" defaultValue="content">
                <option value="content">Content</option>
                <option value="title_meta">Title / meta</option>
                <option value="internal_links">Internal links</option>
                <option value="technical">Technical</option>
                <option value="schema">Schema</option>
                <option value="site_structure">Site structure</option>
                <option value="migration">Migration</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label>
              Implemented date
              <input
                type="date"
                name="implementedAt"
                defaultValue={today}
                required
              />
            </label>

            <label>
              Scope
              <select name="scopeMode" defaultValue="targeted">
                <option value="targeted">Targeted URLs / queries</option>
                <option value="project">Project-wide change</option>
              </select>
            </label>

            <label>
              Target URLs
              <textarea
                name="urls"
                rows={5}
                placeholder={"/blog/example-page\n/blog/another-page"}
              />
            </label>

            <label>
              Target queries
              <textarea
                name="queries"
                rows={5}
                placeholder={"high protein foods\nhow much protein should i eat"}
              />
            </label>

            <label>
              Hypothesis
              <textarea
                name="hypothesis"
                rows={4}
                placeholder="What should improve if this change works?"
              />
            </label>

            <label>
              Notes
              <textarea
                name="notes"
                rows={4}
                placeholder="Implementation details, ticket reference, caveats..."
              />
            </label>

            <button className="primaryButton" type="submit">
              Start monitoring
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>How measurement works</h2>
              <p>Deterministic first-party comparison with data-delay safeguards.</p>
            </div>
          </div>

          <div className="foundationGrid">
            <div>
              <strong>D+7</strong>
              <span>Fast directional check after GSC delay</span>
            </div>
            <div>
              <strong>D+14</strong>
              <span>Early persistence check</span>
            </div>
            <div>
              <strong>D+28</strong>
              <span>Primary post-change observation</span>
            </div>
            <div>
              <strong>Baseline</strong>
              <span>Matching number of days immediately before implementation</span>
            </div>
          </div>

          <p className="muted">
            A result can be improved, declined, mixed or no change. SignalCore reports
            association only; seasonality, SERP changes, competitors and unrelated site
            changes can also affect the metrics.
          </p>
        </section>
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Intervention history</h2>
            <p>Every checkpoint remains attached to the original change record.</p>
          </div>
        </div>

        {(interventions || []).length ? (
          <div className="automationTaskList">
            {(interventions || []).map((intervention) => {
              const targetUrls = urlMap.get(intervention.id) || [];
              const targetQueries = queryMap.get(intervention.id) || [];
              const interventionChecks = checkMap.get(intervention.id) || [];

              return (
                <article className="automationTaskCard" key={intervention.id}>
                  <div className="automationTaskTop">
                    <div>
                      <p className="eyebrow">
                        {intervention.intervention_type.replaceAll("_", " ")} ·{" "}
                        {formatDate(intervention.implemented_at)}
                      </p>
                      <h3>{intervention.title}</h3>
                    </div>
                    <span className={"jobStatus job-" + intervention.status}>
                      {intervention.status}
                    </span>
                  </div>

                  {intervention.hypothesis ? (
                    <p>
                      <strong>Hypothesis:</strong> {intervention.hypothesis}
                    </p>
                  ) : null}

                  <div className="automationTaskMeta">
                    <span>Scope: {intervention.scope_mode}</span>
                    <span>{targetUrls.length} URLs</span>
                    <span>{targetQueries.length} queries</span>
                  </div>

                  {targetUrls.length ? (
                    <div className="automationChain">
                      <strong>Target URLs</strong>
                      {targetUrls.slice(0, 5).map((row) => (
                        <span key={row.id}>{row.url}</span>
                      ))}
                      {targetUrls.length > 5 ? (
                        <span>+ {targetUrls.length - 5} more</span>
                      ) : null}
                    </div>
                  ) : null}

                  {targetQueries.length ? (
                    <div className="automationChain">
                      <strong>Target queries</strong>
                      <span>
                        {targetQueries
                          .slice(0, 8)
                          .map((row) => row.query)
                          .join(" · ")}
                      </span>
                    </div>
                  ) : null}

                  <div className="syncStateList">
                    {interventionChecks.map((check) => (
                      <div className="syncStateRow" key={check.id}>
                        <div>
                          <strong>D+{check.checkpoint_days}</strong>
                          <span>
                            Worker due: {formatDate(check.due_date)}
                            {check.summary ? " · " + check.summary : ""}
                          </span>
                        </div>
                        <div className="buttonRow">
                          <small className={"jobStatus job-" + check.status}>
                            {checkpointLabel(check.status, check.result_class)}
                          </small>
                          {check.status === "pending" ? (
                            <form
                              action={evaluateSeoInterventionCheck.bind(
                                null,
                                id,
                                check.id,
                              )}
                            >
                              <button className="ghostButton" type="submit">
                                Evaluate now
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>

                  {intervention.notes ? (
                    <p className="muted">{intervention.notes}</p>
                  ) : null}

                  {intervention.status === "monitoring" ? (
                    <div className="buttonRow">
                      <form
                        action={cancelSeoIntervention.bind(
                          null,
                          id,
                          intervention.id,
                        )}
                      >
                        <button className="ghostButton" type="submit">
                          Cancel monitoring
                        </button>
                      </form>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <strong>No SEO interventions recorded yet</strong>
            <span>
              Add the first change to start building a measurable SEO work history.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
