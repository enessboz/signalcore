import Link from "next/link";

export function ProjectDataNav({
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
  const items = [
    ["overview", "Project", `/projects/${projectId}`],
    ["gsc", "Search Console", `/projects/${projectId}/search-console`],
    ["ga4", "GA4 Analytics", `/projects/${projectId}/analytics`],
    ["technical", "Technical Audit", `/projects/${projectId}/technical`],
    ["rank", "Rank Tracker", `/projects/${projectId}/rank-tracker`],
    ["interventions", "Interventions", `/projects/${projectId}/interventions`],
    ["health", "Data Health", `/projects/${projectId}/data-health`],
  ] as const;

  return (
    <nav className="projectDataNav">
      {items.map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          className={active === key ? "projectDataNavItem active" : "projectDataNavItem"}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
