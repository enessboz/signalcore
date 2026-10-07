import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";

type SearchParams = Record<string, string | string[] | undefined>;
function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

export default async function OutputsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const supabase = await createClient();
  const projectFilter = scalar(query.project);
  const typeFilter = scalar(query.type);

  const { data: projects } = await supabase
    .from("projects")
    .select("id,name")
    .order("name");

  let outputQuery = supabase
    .from("generated_outputs")
    .select("id,project_id,agent_run_id,output_type,title,status,body_markdown,data,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (projectFilter) outputQuery = outputQuery.eq("project_id", projectFilter);
  if (typeFilter) outputQuery = outputQuery.eq("output_type", typeFilter);

  const { data: outputs, error } = await outputQuery;
  const projectMap = new Map((projects || []).map((project) => [project.id, project.name]));

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "Teslimatlar" : "Deliverables"}</p>
          <h1>{tr ? "Çıktılar" : "Outputs"}</h1>
          <p className="muted">
            {tr ? "SignalCore agentlarının oluşturduğu kalıcı rapor, sunum, task ve email taslakları." : "Persistent report, presentation, task and email drafts produced by SignalCore agents."}
          </p>
        </div>
        <Link href="/command" className="primaryButton">{tr ? "Chief Operator'a sor" : "Ask Chief Operator"}</Link>
      </header>

      {error ? <p className="formMessage formError pageMessage">{error.message}</p> : null}

      <section className="panel filterPanel">
        <form method="get" className="filterForm">
          <label>
            Project
            <select name="project" defaultValue={projectFilter}>
              <option value="">{tr ? "Tüm projeler" : "All projects"}</option>
              {(projects || []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label>
            Format
            <select name="type" defaultValue={typeFilter}>
              <option value="">{tr ? "Tüm formatlar" : "All formats"}</option>
              <option value="summary">Summary</option>
              <option value="document">Document</option>
              <option value="presentation">Presentation</option>
              <option value="task">Task</option>
              <option value="email">Email</option>
            </select>
          </label>
          <button className="secondaryButton" type="submit">{tr ? "Filtreleri uygula" : "Apply filters"}</button>
        </form>
      </section>

      {(outputs || []).length ? (
        <div className="outputGrid">
          {(outputs || []).map((output) => (
            <article className="outputCard" key={output.id}>
              <div className="outputCardTop">
                <div>
                  <p className="eyebrow">{projectMap.get(output.project_id) || "Project"}</p>
                  <h2>{output.title}</h2>
                </div>
                <span className="sourceBadge">{output.output_type}</span>
              </div>
              <p className="outputPreview">
                {output.body_markdown?.slice(0, 340) || "Structured output is stored without a Markdown preview."}
              </p>
              <div className="outputMeta">
                <span>{output.status}</span>
                <span>{new Date(output.created_at).toLocaleString("en-GB")}</span>
              </div>
              <div className="buttonRow">
                <Link className="secondaryButton" href={`/outputs/${output.id}`}>
                  Open
                </Link>
                {output.output_type === "presentation" ? (
                  <a
                    className="ghostButton"
                    href={`/api/outputs/${output.id}/download?format=pptx`}
                  >
                    Download .pptx
                  </a>
                ) : (
                  <a
                    className="ghostButton"
                    href={`/api/outputs/${output.id}/download?format=docx`}
                  >
                    Download .docx
                  </a>
                )}
                <a
                  className="ghostButton"
                  href={`/api/outputs/${output.id}/download?format=md`}
                >
                  .md
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel emptyState">
          <strong>No outputs yet</strong>
          <span>Ask Chief Operator to prepare a report, summary, presentation draft, task or email.</span>
        </section>
      )}
    </div>
  );
}
