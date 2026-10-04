import { notFound } from "next/navigation";
import { ProjectTypeBadge } from "@/components/project-type-badge";
import { createClient } from "@/lib/supabase/server";
import type { ProjectType } from "@/lib/domain/types";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("*").eq("id", id).single();

  if (!project) notFound();

  const [{ count: sources }, { count: facts }, { count: findings }, { count: jobs }] = await Promise.all([
    supabase.from("project_sources").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("project_facts").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("findings").select("id", { count: "exact", head: true }).eq("project_id", id).neq("status", "resolved"),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("project_id", id),
  ]);

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

      <section className="statsGrid">
        <article className="statCard"><span>Sources</span><strong>{sources || 0}</strong><small>Project Brain inputs</small></article>
        <article className="statCard"><span>Facts</span><strong>{facts || 0}</strong><small>Verified or classified knowledge</small></article>
        <article className="statCard"><span>Open findings</span><strong>{findings || 0}</strong><small>Issues + opportunities</small></article>
        <article className="statCard"><span>Jobs</span><strong>{jobs || 0}</strong><small>Manual + scheduled runs</small></article>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div><h2>Project Brain</h2><p>Next milestone: background sources, facts and GSC integration.</p></div>
        </div>
        <div className="foundationGrid">
          <div><strong>Boundary</strong><span>{project.project_type}</span></div>
          <div><strong>Status</strong><span>{project.status}</span></div>
          <div><strong>Automations</strong><span>Not configured yet</span></div>
          <div><strong>Data health</strong><span>Foundation ready</span></div>
        </div>
      </section>
    </div>
  );
}
