import { createClient } from "@/lib/supabase/server";
import { addGlobalBrainEntry, toggleGlobalBrainEntry } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;
function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const supabase = await createClient();
  const { data: entries } = await supabase
    .from("global_brain_entries")
    .select("id,category,title,content,priority,active,updated_at")
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: false });

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Organization memory</p>
          <h1>Global Brain</h1>
          <p className="muted">
            Company-wide rules and context shared by Chief Operator and every specialist agent.
          </p>
        </div>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}

      <div className="twoCol">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>Add Global Brain entry</h2><p>Use high priority for non-negotiable rules.</p></div>
          </div>
          <form className="formPanel" action={addGlobalBrainEntry}>
            <label>
              Category
              <select name="category" defaultValue="rule">
                <option value="company">Company</option>
                <option value="seo_methodology">SEO methodology</option>
                <option value="communication">Communication</option>
                <option value="reporting">Reporting</option>
                <option value="presentation">Presentation</option>
                <option value="sales">Sales</option>
                <option value="development">Development</option>
                <option value="rule">Rule</option>
              </select>
            </label>
            <label>Title<input name="title" required placeholder="e.g. Presentation rules" /></label>
            <label>Priority<input name="priority" type="number" min="0" max="100" defaultValue="80" /></label>
            <label>Content<textarea name="content" rows={10} required placeholder="Add the rule, methodology or company context agents must follow." /></label>
            <button className="primaryButton" type="submit">Add to Global Brain</button>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div><h2>Shared rules</h2><p>{entries?.filter((entry) => entry.active).length || 0} active entries.</p></div>
          </div>
          {(entries || []).length ? (
            <div className="brainEntryList">
              {(entries || []).map((entry) => (
                <article className={entry.active ? "brainEntry" : "brainEntry inactive"} key={entry.id}>
                  <div className="brainEntryTop">
                    <div>
                      <span>{entry.category.replaceAll("_", " ")}</span>
                      <strong>{entry.title}</strong>
                    </div>
                    <small>P{entry.priority}</small>
                  </div>
                  <p>{entry.content}</p>
                  <form action={toggleGlobalBrainEntry.bind(null, entry.id, !entry.active)}>
                    <button className="ghostButton" type="submit">{entry.active ? "Disable" : "Enable"}</button>
                  </form>
                </article>
              ))}
            </div>
          ) : (
            <div className="emptyState smallEmpty">
              <strong>No Global Brain entries yet</strong>
              <span>Add Impavo rules, methodology, output standards and tone here.</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
