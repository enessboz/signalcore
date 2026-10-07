import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";
import { removeBudgetLimit, saveBudgetLimit } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const supabase = await createClient();

  const [
    { data: projects },
    { data: limits },
    { data: usage },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,project_type,status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("budget_limits")
      .select("project_id,category,monthly_limit,soft_warning_percent,hard_stop,updated_at")
      .order("project_id")
      .order("category"),
    supabase
      .from("usage_events")
      .select("id,project_id,category,provider,units,estimated_cost,actual_cost,metadata,created_at")
      .gte("created_at", monthStartIso())
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const projectMap = new Map((projects || []).map((project) => [project.id, project]));
  const spend = new Map<string, number>();

  for (const event of usage || []) {
    const key = `${event.project_id}:${event.category}`;
    spend.set(
      key,
      (spend.get(key) || 0) + Number(event.actual_cost ?? event.estimated_cost ?? 0),
    );
  }

  const categories = ["ai", "serp", "browser"] as const;
  const totalSpend = Array.from(spend.values()).reduce((sum, value) => sum + value, 0);
  const aiSpend = Array.from(spend.entries())
    .filter(([key]) => key.endsWith(":ai"))
    .reduce((sum, [, value]) => sum + value, 0);
  const serpSpend = Array.from(spend.entries())
    .filter(([key]) => key.endsWith(":serp"))
    .reduce((sum, [, value]) => sum + value, 0);
  const configuredBudgets = limits?.length || 0;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "Maliyet kontrolü" : "Cost control"}</p>
          <h1>{tr ? "Maliyet & Bütçeler" : "Costs & Budgets"}</h1>
          <p className="muted">
            {tr ? "Model kullanımı, ücretli SERP verisi ve browser/render maliyetleri için proje seviyesinde guardrailler." : "Project-level guardrails for model usage, paid SERP data and browser/render costs."}
          </p>
        </div>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}

      <section className="healthGrid">
        <article className="healthCard">
          <span>{tr ? "Bu ay" : "This month"}</span>
          <strong>{money(totalSpend)}</strong>
          <small>Recorded SignalCore usage</small>
        </article>
        <article className="healthCard">
          <span>AI</span>
          <strong>{money(aiSpend)}</strong>
          <small>OpenAI agent runs</small>
        </article>
        <article className="healthCard">
          <span>SERP / paid data</span>
          <strong>{money(serpSpend)}</strong>
          <small>Provider-reported costs</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Tanımlı limitler" : "Configured limits"}</span>
          <strong>{configuredBudgets}</strong>
          <small>Project + category budgets</small>
        </article>
        <article className="healthCard">
          <span>Hard stops</span>
          <strong>{(limits || []).filter((limit) => limit.hard_stop).length}</strong>
          <small>Block before paid call</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Takip edilen projeler" : "Projects tracked"}</span>
          <strong>{projects?.length || 0}</strong>
          <small>Active workspaces</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{tr ? "Bütçe guardrail tanımla" : "Set budget guardrail"}</h2>
            <p>
              No limit means no budget hard-stop. A configured hard-stop blocks the next paid call before it begins.
            </p>
          </div>
        </div>

        <form className="budgetForm" action={saveBudgetLimit}>
          <label>
            Project
            <select name="projectId" required defaultValue="">
              <option value="" disabled>Select project</option>
              {(projects || []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.project_type.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>

          <label>
            Category
            <select name="category" defaultValue="ai">
              <option value="ai">AI / model usage</option>
              <option value="serp">SERP / paid data</option>
              <option value="browser">Browser / render</option>
            </select>
          </label>

          <label>
            Monthly USD limit
            <input name="monthlyLimit" type="number" min="0" step="0.01" defaultValue="10" />
          </label>

          <label>
            Warning at %
            <input name="softWarningPercent" type="number" min="1" max="100" defaultValue="80" />
          </label>

          <label className="checkboxLabel">
            <input name="hardStop" type="checkbox" defaultChecked />
            Hard stop
          </label>

          <button className="primaryButton" type="submit">Save budget</button>
        </form>
      </section>

      <section className="budgetProjectGrid">
        {(projects || []).map((project) => {
          const projectLimits = (limits || []).filter((limit) => limit.project_id === project.id);

          return (
            <article className="budgetProjectCard" key={project.id}>
              <div className="budgetProjectHeader">
                <div>
                  <p className="eyebrow">{project.project_type.replaceAll("_", " ")}</p>
                  <h2>{project.name}</h2>
                </div>
              </div>

              <div className="budgetCategoryList">
                {categories.map((category) => {
                  const limit = projectLimits.find((item) => item.category === category);
                  const used = spend.get(`${project.id}:${category}`) || 0;
                  const monthlyLimit = limit ? Number(limit.monthly_limit) : null;
                  const percent = monthlyLimit && monthlyLimit > 0
                    ? Math.min((used / monthlyLimit) * 100, 100)
                    : 0;

                  return (
                    <div className="budgetCategoryRow" key={category}>
                      <div className="budgetCategoryTop">
                        <div>
                          <strong>{category.toUpperCase()}</strong>
                          <span>
                            {limit
                              ? `${money(used)} / ${money(monthlyLimit || 0)}`
                              : `${money(used)} · no limit`}
                          </span>
                        </div>
                        {limit ? (
                          <div className="budgetFlags">
                            <span>{limit.hard_stop ? "hard stop" : "warning only"}</span>
                            <form action={removeBudgetLimit.bind(null, project.id, category)}>
                              <button className="ghostButton" type="submit">Remove</button>
                            </form>
                          </div>
                        ) : null}
                      </div>
                      {limit ? (
                        <>
                          <div className="budgetProgress">
                            <div style={{ width: `${percent}%` }} />
                          </div>
                          <small>
                            Warning at {limit.soft_warning_percent}% · Remaining {money(Math.max((monthlyLimit || 0) - used, 0))}
                          </small>
                        </>
                      ) : (
                        <small>Add a monthly guardrail if this category should be capped.</small>
                      )}
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Usage ledger</h2>
            <p>Current-month recorded usage. Actual provider cost takes precedence over estimates.</p>
          </div>
        </div>

        {(usage || []).length ? (
          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Time</th><th>Project</th><th>Category</th><th>Provider</th><th>Units</th><th>Cost</th><th>Context</th>
                </tr>
              </thead>
              <tbody>
                {(usage || []).map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.created_at).toLocaleString("en-GB")}</td>
                    <td>{projectMap.get(event.project_id)?.name || "Project"}</td>
                    <td>{event.category}</td>
                    <td>{event.provider || "—"}</td>
                    <td>{event.units !== null ? String(event.units) : "—"}</td>
                    <td>{money(Number(event.actual_cost ?? event.estimated_cost ?? 0))}</td>
                    <td><span className="cellEllipsis">{JSON.stringify(event.metadata || {})}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No paid usage has been recorded this month.</span>
          </div>
        )}
      </section>
    </div>
  );
}
