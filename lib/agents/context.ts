import { createClient } from "@/lib/supabase/server";

export type AgentProjectContext = {
  project: {
    id: string;
    name: string;
    domain: string | null;
    project_type: "owned" | "client" | "lead_prospect";
    description: string | null;
    metadata: Record<string, unknown>;
  };
  boundary: string;
  facts: Array<{
    fact_key: string;
    fact_value: unknown;
    knowledge_type: string;
    confidence: string | null;
  }>;
  background: Array<{ content: string; metadata: Record<string, unknown> }>;
  findings: Array<{
    id: string;
    finding_type: string;
    title: string;
    summary: string;
    why_it_matters: string | null;
    importance: string;
    confidence: string;
    status: string;
    affected_scope: Record<string, unknown>;
    recommended_action: string | null;
    metadata: Record<string, unknown>;
  }>;
  bindings: Array<{
    binding_type: string;
    resource_id: string;
    display_name: string | null;
  }>;
  manifest: {
    fact_count: number;
    background_chunk_count: number;
    finding_count: number;
    binding_count: number;
  };
};

function boundaryFor(projectType: string) {
  if (projectType === "lead_prospect") {
    return "LEAD PROSPECT BOUNDARY: Use public/open or explicitly user-supplied evidence only. Do not claim access to first-party analytics, private roadmap, internal decisions, revenue, customers or strategy unless supplied in context. Third-party estimates must be labeled as estimates.";
  }

  if (projectType === "client") {
    return "CLIENT BOUNDARY: Use only information explicitly supplied by the client/user, connected authorized first-party data, and verified public evidence. Do not invent internal roadmap, product plans, business decisions or unavailable company context.";
  }

  return "OWNED PROJECT BOUNDARY: You may reason across supplied internal project context, connected first-party data and verified evidence. Still separate facts from hypotheses and do not invent missing information.";
}

export async function buildAgentProjectContext(
  projectId: string,
): Promise<AgentProjectContext> {
  const supabase = await createClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,name,domain,project_type,description,metadata")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    throw new Error("Project context could not be loaded.");
  }

  const [
    { data: facts },
    { data: background },
    { data: findings },
    { data: bindings },
  ] = await Promise.all([
    supabase
      .from("project_facts")
      .select("fact_key,fact_value,knowledge_type,confidence,updated_at")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(24),
    supabase
      .from("background_chunks")
      .select("content,metadata,created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("findings")
      .select("id,finding_type,title,summary,why_it_matters,importance,confidence,status,affected_scope,recommended_action,metadata,updated_at")
      .eq("project_id", projectId)
      .in("status", ["open", "monitoring"])
      .order("updated_at", { ascending: false })
      .limit(30),
    supabase
      .from("project_bindings")
      .select("binding_type, connection_resources(resource_id,display_name)")
      .eq("project_id", projectId),
  ]);

  const normalizedBindings = (bindings || []).map((binding) => {
    const resource = Array.isArray(binding.connection_resources)
      ? binding.connection_resources[0]
      : binding.connection_resources;

    return {
      binding_type: binding.binding_type,
      resource_id: resource?.resource_id || "",
      display_name: resource?.display_name || null,
    };
  });

  return {
    project: {
      ...project,
      metadata: (project.metadata || {}) as Record<string, unknown>,
    },
    boundary: boundaryFor(project.project_type),
    facts: (facts || []).map(({ fact_key, fact_value, knowledge_type, confidence }) => ({
      fact_key,
      fact_value,
      knowledge_type,
      confidence,
    })),
    background: (background || []).map(({ content, metadata }) => ({
      content,
      metadata: (metadata || {}) as Record<string, unknown>,
    })),
    findings: (findings || []).map((finding) => ({
      ...finding,
      affected_scope: (finding.affected_scope || {}) as Record<string, unknown>,
      metadata: (finding.metadata || {}) as Record<string, unknown>,
    })),
    bindings: normalizedBindings,
    manifest: {
      fact_count: facts?.length || 0,
      background_chunk_count: background?.length || 0,
      finding_count: findings?.length || 0,
      binding_count: normalizedBindings.length,
    },
  };
}

export function contextToPrompt(context: AgentProjectContext) {
  const compact = {
    project: context.project,
    boundary: context.boundary,
    facts: context.facts,
    background: context.background,
    open_findings: context.findings,
    connected_resources: context.bindings,
  };

  return JSON.stringify(compact, null, 2);
}
