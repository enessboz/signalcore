import { notFound } from "next/navigation";
import { ProjectTypeBadge } from "@/components/project-type-badge";
import { createClient } from "@/lib/supabase/server";
import type { ProjectType } from "@/lib/domain/types";
import { addBackgroundSource } from "./actions";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("*").eq("id", id).single();

  if (!project) notFound();

  const [
    { count: sources },
    { count: facts },
    { count: findings },
    { count: jobs },
    { count: chunks },
    { data: recentSources },
  ] = await Promise.all([
    supabase.from("project_sources").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("project_facts").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("findings").select("id", { count: "exact", head: true }).eq("project_id", id).neq("status", "resolved"),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("background_chunks").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("project_sources").select("id,title,source_type,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(6),
  ]);

  const addSource = addBackgroundSource.bind(null, id);

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Project workspace</p>
          <h1>{project.name}</h1>
          <p className="muted">{project.domain || "Domain not configured"}</p>
        </div>
        <ProjectTypeBadge type={project.project_type as ProjectType} />
      </header>

      {query.error ? <p className="formMessage formError pageMessage">{query.error}</p> : null}
      {query.message ? <p className="formMessage formSuccess pageMessage">{query.message}</p> : null}

      <section className="statsGrid">
        <article className="statCard"><span>Sources</span><strong>{sources || 0}</strong><small>Project Brain inputs</small></article>
        <article className="statCard"><span>Chunks</span><strong>{chunks || 0}</strong><small>Searchable background segments</small></article>
        <article className="statCard"><span>Open findings</span><strong>{findings || 0}</strong><small>Issues + opportunities</small></article>
        <article className="statCard"><span>Jobs</span><strong>{jobs || 0}</strong><small>Manual + scheduled runs</small></article>
      </section>

      <div className="twoCol">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>Add Project Brain source</h2><p>Manual background is stored as a source and chunked deterministically.</p></div>
          </div>
          <form className="formPanel" action={addSource}>
            <label>Source title<input name="title" placeholder="e.g. EatBetter SEO Background — October 2026" required /></label>
            <label>Background text<textarea name="content" rows={12} placeholder="Paste project background, known SEO history, client-provided context, rules or decisions." required /></label>
            <button className="primaryButton" type="submit">Add to Project Brain</button>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div><h2>Recent sources</h2><p>Source history remains separate from AI interpretations.</p></div>
          </div>
          {recentSources?.length ? (
            <div className="sourceList">
              {recentSources.map((source) => (
                <article className="sourceRow" key={source.id}>
                  <div><strong>{source.title}</strong><span>{source.source_type.replaceAll("_", " ")}</span></div>
                  <small>{new Date(source.created_at).toLocaleDateString("en-GB")}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className="emptyState smallEmpty"><strong>No background sources yet</strong><span>Add the first LLM Background or project note.</span></div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panelHeader"><div><h2>Project Brain status</h2><p>Retrieval is deterministic full-text in this milestone; embeddings/LLM extraction come later.</p></div></div>
        <div className="foundationGrid">
          <div><strong>Boundary</strong><span>{project.project_type}</span></div>
          <div><strong>Verified facts</strong><span>{facts || 0}</span></div>
          <div><strong>Automations</strong><span>Not configured yet</span></div>
          <div><strong>Data health</strong><span>Project Brain storage ready</span></div>
        </div>
      </section>
    </div>
  );
}
