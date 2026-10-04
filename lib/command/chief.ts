type ChiefAction = {
  type:
    | "create_project"
    | "delegate_agent"
    | "create_ga4_funnel"
    | "schedule_agent_task"
    | "manage_schedule"
    | "request_report"
    | "run_technical_audit"
    | "run_prospect_audit"
    | "link_github_repo"
    | "run_serp_research"
    | "set_google_auto_sync"
    | "queue_google_backfill"
    | "add_global_brain_entry"
    | "add_project_background"
    | "assign_output_profile"
    | "set_budget_limit"
    | "convert_project_to_client"
    | "create_sales_campaign"
    | "run_sales_campaign"
    | "qualify_sales_campaign"
    | "configure_sales_automation"
    | "convert_sales_lead"
    | "audit_sales_lead"
    | "create_sales_deck"
    | "no_action";
  project_ref: string | null;
  project_type: "owned" | "client" | "lead_prospect" | null;
  domain: string | null;
  description: string | null;
  agent_key: string | null;
  task: string | null;
  funnel_name: string | null;
  funnel_steps: Array<{ name: string; event_name: string }>;
  breakdown_dimension: string | null;
  open_funnel: boolean | null;
  schedule_name: string | null;
  schedule_kind: "once" | "daily" | "weekly" | "monthly" | null;
  run_at: string | null;
  time_local: string | null;
  days_of_week: number[];
  day_of_month: number | null;
  window_end_local: string | null;
  timezone: string | null;
  schedule_status: "active" | "paused" | "cancelled" | null;
  report_format: "summary" | "document" | "presentation" | "task" | "email" | null;
  max_urls: number | null;
  repo_full_name: string | null;
  keywords: string[];
  location_code: number | null;
  language_code: string | null;
  data_source: "gsc" | "ga4" | null;
  enabled: boolean | null;
  backfill_days: number | null;
  follow_up_report: boolean | null;
  minimum_importance: "critical" | "high" | "medium" | "low" | null;
  brain_category: "company" | "seo_methodology" | "communication" | "reporting" | "presentation" | "sales" | "development" | "rule" | null;
  entry_title: string | null;
  entry_content: string | null;
  priority: number | null;
  background_title: string | null;
  background_content: string | null;
  output_profile_ref: string | null;
  output_type: "summary" | "document" | "presentation" | "task" | "email" | null;
  budget_category: "ai" | "serp" | "browser" | null;
  monthly_limit: number | null;
  soft_warning_percent: number | null;
  hard_stop: boolean | null;
  campaign_ref: string | null;
  campaign_name: string | null;
  lead_ref: string | null;
  sales_queries: string[];
  exclusions: string[];
  country: string | null;
  industry: string | null;
  min_score: number | null;
  max_candidates: number | null;
  max_run_cost: number | null;
  auto_qualify_count: number | null;
};

export type ChiefPlan = {
  reply: string;
  needs_clarification: boolean;
  clarification_question: string | null;
  actions: ChiefAction[];
};

type ResponsesPayload = {
  id?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
};

function extractText(payload: ResponsesPayload) {
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("Chief Operator response did not contain output text.");
}

const actionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "project_ref",
    "project_type",
    "domain",
    "description",
    "agent_key",
    "task",
    "funnel_name",
    "funnel_steps",
    "breakdown_dimension",
    "open_funnel",
    "schedule_name",
    "schedule_kind",
    "run_at",
    "time_local",
    "days_of_week",
    "day_of_month",
    "window_end_local",
    "timezone",
    "schedule_status",
    "report_format",
    "max_urls",
    "repo_full_name",
    "keywords",
    "location_code",
    "language_code",
    "data_source",
    "enabled",
    "backfill_days",
    "follow_up_report",
    "minimum_importance",
    "brain_category",
    "entry_title",
    "entry_content",
    "priority",
    "background_title",
    "background_content",
    "output_profile_ref",
    "output_type",
    "budget_category",
    "monthly_limit",
    "soft_warning_percent",
    "hard_stop",
    "campaign_ref",
    "campaign_name",
    "lead_ref",
    "sales_queries",
    "exclusions",
    "country",
    "industry",
    "min_score",
    "max_candidates",
    "max_run_cost",
    "auto_qualify_count",
  ],
  properties: {
    type: {
      type: "string",
      enum: [
        "create_project",
        "delegate_agent",
        "create_ga4_funnel",
        "schedule_agent_task",
        "manage_schedule",
        "request_report",
        "run_technical_audit",
        "run_prospect_audit",
        "link_github_repo",
        "run_serp_research",
        "set_google_auto_sync",
        "queue_google_backfill",
        "add_global_brain_entry",
        "add_project_background",
        "assign_output_profile",
        "set_budget_limit",
        "convert_project_to_client",
        "create_sales_campaign",
        "run_sales_campaign",
        "qualify_sales_campaign",
        "configure_sales_automation",
        "convert_sales_lead",
        "audit_sales_lead",
        "create_sales_deck",
        "no_action",
      ],
    },
    project_ref: { type: ["string", "null"] },
    project_type: {
      type: ["string", "null"],
      enum: ["owned", "client", "lead_prospect", null],
    },
    domain: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    agent_key: { type: ["string", "null"] },
    task: { type: ["string", "null"] },
    funnel_name: { type: ["string", "null"] },
    funnel_steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "event_name"],
        properties: {
          name: { type: "string" },
          event_name: { type: "string" },
        },
      },
    },
    breakdown_dimension: { type: ["string", "null"] },
    open_funnel: { type: ["boolean", "null"] },
    schedule_name: { type: ["string", "null"] },
    schedule_kind: {
      type: ["string", "null"],
      enum: ["once", "daily", "weekly", "monthly", null],
    },
    run_at: { type: ["string", "null"] },
    time_local: { type: ["string", "null"] },
    days_of_week: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
    day_of_month: { type: ["integer", "null"], minimum: 1, maximum: 31 },
    window_end_local: { type: ["string", "null"] },
    timezone: { type: ["string", "null"] },
    schedule_status: {
      type: ["string", "null"],
      enum: ["active", "paused", "cancelled", null],
    },
    report_format: {
      type: ["string", "null"],
      enum: ["summary", "document", "presentation", "task", "email", null],
    },
    max_urls: { type: ["integer", "null"], minimum: 1, maximum: 500 },
    repo_full_name: { type: ["string", "null"] },
    keywords: { type: "array", maxItems: 10, items: { type: "string" } },
    location_code: { type: ["integer", "null"] },
    language_code: { type: ["string", "null"] },
    data_source: {
      type: ["string", "null"],
      enum: ["gsc", "ga4", null],
    },
    enabled: { type: ["boolean", "null"] },
    backfill_days: { type: ["integer", "null"], enum: [30, 90, 180, null] },
    follow_up_report: { type: ["boolean", "null"] },
    minimum_importance: {
      type: ["string", "null"],
      enum: ["critical", "high", "medium", "low", null],
    },
    brain_category: {
      type: ["string", "null"],
      enum: ["company", "seo_methodology", "communication", "reporting", "presentation", "sales", "development", "rule", null],
    },
    entry_title: { type: ["string", "null"] },
    entry_content: { type: ["string", "null"] },
    priority: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    background_title: { type: ["string", "null"] },
    background_content: { type: ["string", "null"] },
    output_profile_ref: { type: ["string", "null"] },
    output_type: {
      type: ["string", "null"],
      enum: ["summary", "document", "presentation", "task", "email", null],
    },
    budget_category: {
      type: ["string", "null"],
      enum: ["ai", "serp", "browser", null],
    },
    monthly_limit: { type: ["number", "null"], minimum: 0 },
    soft_warning_percent: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    hard_stop: { type: ["boolean", "null"] },
    campaign_ref: { type: ["string", "null"] },
    campaign_name: { type: ["string", "null"] },
    lead_ref: { type: ["string", "null"] },
    sales_queries: { type: "array", maxItems: 20, items: { type: "string" } },
    exclusions: { type: "array", maxItems: 50, items: { type: "string" } },
    country: { type: ["string", "null"] },
    industry: { type: ["string", "null"] },
    min_score: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    max_candidates: { type: ["integer", "null"], minimum: 1, maximum: 1000 },
    max_run_cost: { type: ["number", "null"], minimum: 0 },
    auto_qualify_count: { type: ["integer", "null"], minimum: 0, maximum: 10 },
  },
};

const chiefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "needs_clarification", "clarification_question", "actions"],
  properties: {
    reply: { type: "string" },
    needs_clarification: { type: "boolean" },
    clarification_question: { type: ["string", "null"] },
    actions: {
      type: "array",
      maxItems: 8,
      items: actionSchema,
    },
  },
};

export async function planChiefOperatorCommand(input: {
  model: string;
  instructions: string;
  userMessage: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  workspaceContext: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured in Vercel.");
  }

  const conversationText = input.conversation
    .slice(-12)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      store: false,
      instructions: input.instructions,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `CURRENT TIME: ${new Date().toISOString()}\nDEFAULT TIMEZONE: Europe/Istanbul\n\nWORKSPACE CONTEXT:\n${input.workspaceContext}\n\nRECENT CONVERSATION:\n${conversationText || "(none)"}\n\nNEW USER MESSAGE:\n${input.userMessage}\n\nYou may also safely add organization rules to Global Brain, add explicitly user-supplied background to a Project Brain, assign an existing output profile to a project, configure project AI/SERP/browser monthly budgets, and manage the internal Sales lead pipeline. For Sales discovery, create campaigns only from user-provided or clearly requested ICP queries. Discovery and qualification are internal/public-data operations; never send outreach automatically. A sales lead can be converted to a Lead Prospect project, audited with public data, and turned into a strict-profile sales deck. When the user explicitly says a Lead Prospect is won/onboarded, you may convert that existing project to Client without creating a new project. Do not infer background text the user did not provide. For first-party data operations, you may safely toggle project-level GSC/GA4 auto sync or queue 30/90/180-day backfills only when the referenced project already has the corresponding property bound. For scheduled agent work, if the user asks for a report only when something important is found, set follow_up_report=true, choose the requested report_format, and set minimum_importance (default high when the user says important/meaningful without a threshold). Return only safe internal actions. If the user asks for an external-impact action such as publishing, deploying, deleting data, sending outreach, modifying production CMS/code, or changing third-party systems, do not execute it as a direct action. Explain that it must go through an approval-required specialist.`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "signalcore_chief_operator_plan",
          description: "Safe executive command plan for SignalCore.",
          strict: true,
          schema: chiefSchema,
        },
      },
      max_output_tokens: 2200,
    }),
    cache: "no-store",
  });

  const payload = (await response.json()) as ResponsesPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message || "Chief Operator model request failed.");
  }

  const text = extractText(payload);
  return {
    responseId: payload.id || null,
    usage: {
      inputTokens: payload.usage?.input_tokens || 0,
      outputTokens: payload.usage?.output_tokens || 0,
    },
    plan: JSON.parse(text) as ChiefPlan,
  };
}
