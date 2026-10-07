import Link from "next/link";
import { ProjectTypeBadge } from "@/components/project-type-badge";
import { createClient } from "@/lib/supabase/server";
import type { ProjectType } from "@/lib/domain/types";
import { getLocale } from "@/lib/i18n";

export default async function ProjectsPage() {
  const locale = await getLocale();
  const tr = locale === "tr";
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id,name,domain,project_type,status,created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "Çalışma Alanı" : "Workspace"}</p>
          <h1>{tr ? "Projeler" : "Projects"}</h1>
          <p className="muted">
            {tr
              ? "Tüm SEO çalışma alanlarını, veri bağlantılarını ve otomasyon sınırlarını tek yerden yönet."
              : "Manage SEO workspaces, data connections and automation boundaries from one place."}
          </p>
        </div>
        <Link href="/new-project" className="primaryButton">
          {tr ? "Yeni proje" : "New project"}
        </Link>
      </header>

      <section className="panel">
        {error ? <p className="formMessage formError">{error.message}</p> : null}

        {projects?.length ? (
          <div className="tableLike">
            {projects.map((project) => (
              <Link className="tableRow" href={`/projects/${project.id}`} key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <span>{project.domain || (tr ? "Henüz domain yok" : "No domain yet")}</span>
                </div>
                <ProjectTypeBadge type={project.project_type as ProjectType} />
                <span>{project.status}</span>
                <span>{tr ? "0 bulgu" : "0 findings"}</span>
                <span>{new Date(project.created_at).toLocaleDateString(tr ? "tr-TR" : "en-GB")}</span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="emptyState">
            <strong>{tr ? "Henüz proje yok" : "No projects yet"}</strong>
            <span>
              {tr
                ? "Project Brain ve entegrasyonları oluşturmaya başlamak için ilk çalışma alanını aç."
                : "Create the first workspace to start building Project Brain and integrations."}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
