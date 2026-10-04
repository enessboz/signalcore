import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();

  const [
    { count: projectCount },
    { count: opportunityCount },
    { count: issueCount },
    { count: approvalCount },
    { data: latestProjects },
  ] = await Promise.all([
    supabase.from("projects").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("findings").select("id", { count: "exact", head: true }).eq("finding_type", "opportunity").neq("status", "resolved"),
    supabase.from("findings").select("id", { count: "exact", head: true }).in("finding_type", ["issue", "regression"]).neq("status", "resolved"),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("projects").select("id,name,domain,project_type,status").order("created_at", { ascending: false }).limit(5),
  ]);

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">SignalCore workspace</p>
          <h1>Daily Inbox</h1>
          <p className="muted">What needs attention across SEO, sales and project monitoring.</p>
        </div>
        <Link href="/new-project" className="primaryButton">New project</Link>
      </header>

      <section className="statsGrid">
        <article className="statCard"><span>Active projects</span><strong>{projectCount || 0}</strong><small>Connected workspaces</small></article>
        <article className="statCard"><span>Open opportunities</span><strong>{opportunityCount || 0}</strong><small>Evidence-backed growth signals</small></article>
        <article className="statCard"><span>Issues</span><strong>{issueCount || 0}</strong><small>Includes regressions</small></article>
        <article className="statCard"><span>Approvals</span><strong>{approvalCount || 0}</strong><small>Actions waiting for review</small></article>
      </section>

      <div className="twoCol">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>Needs attention</h2><p>Findings will appear here after data engines are connected.</p></div>
          </div>
          <div className="emptyState">
            <strong>Foundation is live</strong>
            <span>Next: Project Brain ingestion and Google Search Console sync.</span>
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div><h2>Recent projects</h2><p>Owned, client and lead work remain isolated.</p></div>
            <Link href="/projects">View all</Link>
          </div>

          {latestProjects?.length ? (
            <div className="projectList">
              {latestProjects.map((project) => (
                <Link className="projectRow" key={project.id} href={`/projects/${project.id}`}>
                  <div><strong>{project.name}</strong><span>{project.domain || "No domain"}</span></div>
                  <span className={`badge badge-${project.project_type}`}>{project.project_type.replace("_", " ")}</span>
                  <div className="projectMeta"><span>{project.status}</span><small>Open workspace</small></div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="emptyState"><strong>No projects yet</strong><span>Create the first project to start.</span></div>
          )}
        </section>
      </div>

      <section className="panel compactPanel">
        <div className="panelHeader">
          <div><h2>Foundation status</h2><p>Supabase schema, RLS and authenticated project persistence are wired.</p></div>
        </div>
        <div className="foundationGrid">
          <div><strong>Project model</strong><span>Owned / Client / Lead Prospect</span></div>
          <div><strong>Database</strong><span>RLS enabled on all foundation tables</span></div>
          <div><strong>LLM calls</strong><span>Disabled until Project Brain + data engines</span></div>
          <div><strong>Next milestone</strong><span>Background ingestion + GSC connector</span></div>
        </div>
      </section>
    </div>
  );
}
