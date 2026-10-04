import Link from "next/link";
import { ProjectTypeBadge } from "@/components/project-type-badge";
import { createClient } from "@/lib/supabase/server";
import type { ProjectType } from "@/lib/domain/types";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id,name,domain,project_type,status,created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Projects</h1>
          <p className="muted">Project type defines knowledge boundaries, permissions and automation policy.</p>
        </div>
        <Link href="/new-project" className="primaryButton">New project</Link>
      </header>

      <section className="panel">
        {error ? <p className="formMessage formError">{error.message}</p> : null}

        {projects?.length ? (
          <div className="tableLike">
            {projects.map((project) => (
              <Link className="tableRow" href={`/projects/${project.id}`} key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <span>{project.domain || "No domain yet"}</span>
                </div>
                <ProjectTypeBadge type={project.project_type as ProjectType} />
                <span>{project.status}</span>
                <span>0 findings</span>
                <span>{new Date(project.created_at).toLocaleDateString("en-GB")}</span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="emptyState">
            <strong>No projects yet</strong>
            <span>Create the first workspace to start building Project Brain and integrations.</span>
          </div>
        )}
      </section>
    </div>
  );
}
