type AgentOutput = {
  summary: string;
  importance: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  findings: Array<{
    title: string;
    finding_type: "issue" | "opportunity" | "strategy_discovery" | "observation";
    why_it_matters: string;
    recommended_action: string;
    evidence_refs: string[];
  }>;
  next_actions: string[];
  proposed_actions: Array<{
    action_type: "publish" | "deploy" | "github_write" | "cms_write" | "send_outreach" | "delete" | "external_change" | "approve_output";
    title: string;
    summary: string;
    risk_level: "low" | "medium" | "high" | "critical";
    target: string | null;
    instructions: string;
  }>;
  handoff: {
    needed: boolean;
    to_agent_key: string | null;
    reason: string | null;
  };
};

type RouteOutput = {
  selected_agent: string;
  task_type: string;
  reason: string;
  use_strong_model: boolean;
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
  throw new Error("OpenAI response did not contain output text.");
}

async function callResponses(body: Record<string, unknown>) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured in Vercel.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, store: false }),
    cache: "no-store",
  });

  const payload = (await response.json()) as ResponsesPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI Responses API request failed.");
  }

  return {
    responseId: payload.id || null,
    text: extractText(payload),
    usage: {
      inputTokens: payload.usage?.input_tokens || 0,
      outputTokens: payload.usage?.output_tokens || 0,
    },
  };
}

const specialistSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "importance", "confidence", "findings", "next_actions", "proposed_actions", "handoff"],
  properties: {
    summary: { type: "string" },
    importance: { type: "string", enum: ["critical", "high", "medium", "low"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "finding_type",
          "why_it_matters",
          "recommended_action",
          "evidence_refs",
        ],
        properties: {
          title: { type: "string" },
          finding_type: {
            type: "string",
            enum: ["issue", "opportunity", "strategy_discovery", "observation"],
          },
          why_it_matters: { type: "string" },
          recommended_action: { type: "string" },
          evidence_refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    next_actions: { type: "array", items: { type: "string" } },
    proposed_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action_type", "title", "summary", "risk_level", "target", "instructions"],
        properties: {
          action_type: {
            type: "string",
            enum: ["publish", "deploy", "github_write", "cms_write", "send_outreach", "delete", "external_change", "approve_output"],
          },
          title: { type: "string" },
          summary: { type: "string" },
          risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
          target: { type: ["string", "null"] },
          instructions: { type: "string" },
        },
      },
    },
    handoff: {
      type: "object",
      additionalProperties: false,
      required: ["needed", "to_agent_key", "reason"],
      properties: {
        needed: { type: "boolean" },
        to_agent_key: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
      },
    },
  },
};

const routeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selected_agent", "task_type", "reason", "use_strong_model"],
  properties: {
    selected_agent: { type: "string" },
    task_type: { type: "string" },
    reason: { type: "string" },
    use_strong_model: { type: "boolean" },
  },
};

export async function runStructuredAgent(input: {
  model: string;
  instructions: string;
  request: string;
  projectContext: string;
}) {
  const result = await callResponses({
    model: input.model,
    instructions: input.instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `USER REQUEST:\n${input.request}\n\nPROJECT CONTEXT:\n${input.projectContext}\n\nACTION POLICY:\nNever claim that you executed an external change. If the requested or recommended next step would publish, deploy, write to GitHub/CMS, send outreach, delete data, or otherwise change an external system, include it under proposed_actions so SignalCore can request explicit approval. Keep proposed_actions empty when no external action is needed.`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "signalcore_agent_result",
        description: "Structured SignalCore specialist agent result.",
        strict: true,
        schema: specialistSchema,
      },
    },
    max_output_tokens: 2400,
  });

  return {
    ...result,
    output: JSON.parse(result.text) as AgentOutput,
  };
}

export async function routeAgentTask(input: {
  model: string;
  instructions: string;
  request: string;
  projectContext: string;
  availableAgents: Array<{ agent_key: string; name: string; description: string }>;
}) {
  const available = input.availableAgents
    .map((agent) => `- ${agent.agent_key}: ${agent.name} — ${agent.description}`)
    .join("\n");

  const result = await callResponses({
    model: input.model,
    instructions: input.instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Route this task to exactly one specialist.\n\nTASK:\n${input.request}\n\nAVAILABLE SPECIALISTS:\n${available}\n\nPROJECT CONTEXT:\n${input.projectContext}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "signalcore_route_decision",
        description: "SignalCore routing decision.",
        strict: true,
        schema: routeSchema,
      },
    },
    max_output_tokens: 500,
  });

  return {
    ...result,
    output: JSON.parse(result.text) as RouteOutput,
  };
}

export function estimateModelCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  const rates: Record<string, { input: number; output: number }> = {
    "gpt-6-luna": { input: 0.1, output: 0.5 },
    "gpt-6-sol": { input: 2, output: 10 },
  };
  const rate = rates[model];
  if (!rate) return null;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}
