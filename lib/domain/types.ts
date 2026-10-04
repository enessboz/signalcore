export type ProjectType = "owned" | "client" | "lead_prospect";
export type ProjectStatus = "active" | "paused" | "archived";
export type FindingType =
  | "issue"
  | "opportunity"
  | "strategy_discovery"
  | "regression"
  | "experiment_update"
  | "data_health";

export type Importance = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
