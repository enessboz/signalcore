import Link from "next/link";
import { getLocale } from "@/lib/i18n";

export async function ProjectDataNav({
  projectId,
  active,
}: {
  projectId: string;
  active:
    | "overview"
    | "gsc"
    | "ga4"
    | "technical"
    | "rank"
    | "interventions"
    | "health";
}) {
  const locale = await getLocale();
  const tr = locale === "tr";

  const items = [
    ["overview", tr ? "Proje" : "Project", `/projects/${projectId}`],
    ["gsc", "Search Console", `/projects/${projectId}/search-console`],
    ["ga4", "GA4 Analytics", `/projects/${projectId}/analytics`],
    ["technical", tr ? "Teknik Denetim" : "Technical Audit", `/projects/${projectId}/technical`],
    ["rank", "Rank Tracker", `/projects/${projectId}/rank-tracker`],
    ["interventions", tr ? "Intervention'lar" : "Interventions", `/projects/${projectId}/interventions`],
    ["health", tr ? "Veri Sağlığı" : "Data Health", `/projects/${projectId}/data-health`],
  ] as const;

  return (
    <nav className="projectDataNav">
      {items.map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          className={
            active === key
              ? "projectDataNavItem active"
              : "projectDataNavItem"
          }
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
