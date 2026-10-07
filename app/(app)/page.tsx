import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { dashboardCopy, getLocale } from "@/lib/i18n";

function MetricIcon({
  type,
}: {
  type: "projects" | "opportunities" | "issues" | "approvals";
}) {
  const paths = {
    projects: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>,
    opportunities: <><path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/></>,
    issues: <><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></>,
    approvals: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
  };
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[type]}
    </svg>
  );
}

export default async function Home() {
  const locale = await getLocale();
  const t = dashboardCopy(locale);
  const supabase = await createClient();

  const [
    { count: projectCount },
    { count: opportunityCount },
    { count: issueCount },
    { count: approvalCount },
    { data: latestProjects },
    { data: latestFindings },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("findings")
      .select("id", { count: "exact", head: true })
      .eq("finding_type", "opportunity")
      .neq("status", "resolved"),
    supabase
      .from("findings")
      .select("id", { count: "exact", head: true })
      .in("finding_type", ["issue", "regression"])
      .neq("status", "resolved"),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("projects")
      .select("id,name,domain,project_type,status")
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("findings")
      .select("id,title,summary,importance,finding_type,project_id")
      .neq("status", "resolved")
      .order("updated_at", { ascending: false })
      .limit(5),
  ]);

  const metricCards = [
    {
      label: t.activeProjects,
      value: projectCount || 0,
      hint: t.activeProjectsHint,
      type: "projects" as const,
      tone: "",
    },
    {
      label: t.opportunities,
      value: opportunityCount || 0,
      hint: t.opportunitiesHint,
      type: "opportunities" as const,
      tone: "success",
    },
    {
      label: t.issues,
      value: issueCount || 0,
      hint: t.issuesHint,
      type: "issues" as const,
      tone: "danger",
    },
    {
      label: t.approvals,
      value: approvalCount || 0,
      hint: t.approvalsHint,
      type: "approvals" as const,
      tone: "warn",
    },
  ];

  return (
    <div className="page">
      <section className="dashboardHero">
        <div className="dashboardHeroContent">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p className="muted">{t.subtitle}</p>
          <div className="dashboardHeroActions">
            <Link href="/command" className="primaryButton">
              {t.commandCta}
            </Link>
            <Link href="/new-project" className="secondaryButton">
              {t.newProject}
            </Link>
          </div>
        </div>
      </section>

      <section className="statsGrid dashboardStats">
        {metricCards.map((metric) => (
          <article className="statCard" key={metric.label}>
            <div className="metricTopline">
              <span>{metric.label}</span>
              <span className={"metricIcon " + metric.tone}>
                <MetricIcon type={metric.type} />
              </span>
            </div>
            <strong>{metric.value}</strong>
            <small>{metric.hint}</small>
          </article>
        ))}
      </section>

      <div className="dashboardGrid">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>{t.attention}</h2>
              <p>{t.attentionHint}</p>
            </div>
            <Link href="/opportunities">{t.viewAll}</Link>
          </div>

          {latestFindings?.length ? (
            <div className="findingList">
              {latestFindings.map((finding) => (
                <Link
                  className="finding"
                  key={finding.id}
                  href={
                    finding.finding_type === "opportunity"
                      ? "/opportunities"
                      : "/issues"
                  }
                >
                  <span
                    className={
                      "signal " +
                      (finding.finding_type === "opportunity"
                        ? "signal-positive"
                        : finding.importance === "high"
                          ? "signal-negative"
                          : "signal-neutral")
                    }
                  />
                  <div className="findingBody">
                    <small>
                      {finding.finding_type.replaceAll("_", " ")} ·{" "}
                      {finding.importance}
                    </small>
                    <strong>{finding.title}</strong>
                    <span>{finding.summary}</span>
                  </div>
                  <span className="ghostButton">→</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="intelligenceEmpty">
              <div className="intelligenceOrb">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 17 9 12l4 4 7-9"/>
                  <path d="M15 7h5v5"/>
                </svg>
              </div>
              <strong>
                {locale === "tr"
                  ? "Kritik bir sinyal yok"
                  : "No critical signals right now"}
              </strong>
              <p>
                {locale === "tr"
                  ? "Yeni crawler, GSC, GA4 ve rank tracking verileri geldikçe en önemli fırsatlar ve riskler burada öne çıkar."
                  : "As crawler, GSC, GA4 and rank-tracking evidence arrives, the highest-value opportunities and risks will surface here."}
              </p>
              <Link href="/opportunities" className="ghostButton">
                {t.viewAll}
              </Link>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>{t.projectsTitle}</h2>
              <p>{t.projectsHint}</p>
            </div>
            <Link href="/projects">{t.viewAll}</Link>
          </div>

          {latestProjects?.length ? (
            <div className="projectList">
              {latestProjects.map((project) => (
                <Link
                  className="projectRow"
                  key={project.id}
                  href={"/projects/" + project.id}
                >
                  <div>
                    <strong>{project.name}</strong>
                    <span>{project.domain || "—"}</span>
                  </div>
                  <span className={"badge badge-" + project.project_type}>
                    {t[
                      project.project_type as
                        | "owned"
                        | "client"
                        | "lead_prospect"
                    ]}
                  </span>
                  <div className="projectMeta">
                    <span>{project.status}</span>
                    <small>{t.openWorkspace}</small>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="emptyState smallEmpty">
              <strong>{t.noProjects}</strong>
              <span>{t.noProjectsHint}</span>
            </div>
          )}
        </section>
      </div>

      <section className="panel compactPanel">
        <div className="panelHeader">
          <div>
            <h2>{t.statusTitle}</h2>
            <p>{t.statusHint}</p>
          </div>
          <Link href="/readiness">{t.viewAll}</Link>
        </div>
        <div className="systemPulse">
          <div className="pulseItem">
            <div className="pulseTop">
              <strong>{t.crawler}</strong>
              <span className="statusDot" />
            </div>
            <span>{t.crawlerHint}</span>
            <span className="pulseState">{t.ready}</span>
          </div>
          <div className="pulseItem">
            <div className="pulseTop">
              <strong>{t.warehouse}</strong>
              <span className="statusDot" />
            </div>
            <span>{t.warehouseHint}</span>
            <span className="pulseState">{t.healthy}</span>
          </div>
          <div className="pulseItem">
            <div className="pulseTop">
              <strong>{t.automation}</strong>
              <span className="statusDot" />
            </div>
            <span>{t.automationHint}</span>
            <span className="pulseState">{t.active}</span>
          </div>
          <div className="pulseItem">
            <div className="pulseTop">
              <strong>{t.safety}</strong>
              <span className="statusDot" />
            </div>
            <span>{t.safetyHint}</span>
            <span className="pulseState">{t.protected}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
