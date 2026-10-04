import type { ProjectType } from "@/lib/domain/types";

const labels: Record<ProjectType, string> = {
  owned: "Owned",
  client: "Client",
  lead_prospect: "Lead Prospect",
};

export function ProjectTypeBadge({ type }: { type: ProjectType }) {
  return <span className={`badge badge-${type}`}>{labels[type]}</span>;
}
