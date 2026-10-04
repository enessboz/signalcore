import type { SupabaseClient } from "@supabase/supabase-js";
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
  global_brain: Array<{
    category: string;
    title: string;
    content: string;
    priority: number;
  }>;
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
  serp_evidence: Array<{
    keyword: string;
    location_code: number | null;
    language_code: string | null;
    status: string;
    result: Record<string, unknown>;
    checked_at: string;
  }>;
  repositories: Array<{
    repo_full_name: string;
    default_branch: string | null;
    access_mode: string;
    status: string;
  }>;
  warehouse_summary: {
    gsc: Record<string, unknown> | null;
    ga4: Record<string, unknown> | null;
  };
  latest_crawl: null | {
    id: string;
    crawl_type: string;
    status: string;
    summary: Record<string, unknown>;
    completed_at: string | null;
    pages: Array<{
      url: string;
      status_code: number | null;
      title: string | null;
      canonical: string | null;
      robots_meta: string | null;
      h1s: unknown;
      word_count: number;
      internal_link_count: number;
      structured_data_count: number;
      fetch_error: string | null;
    }>;
  };
  manifest: {
    fact_count: number;
    background_chunk_count: number;
    finding_count: number;
    binding_count: number;
    crawl_page_count: number;
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
  client?: SupabaseClient,
): Promise<AgentProjectContext> {
  const supabase = client || (await createClient());

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,owner_id,name,domain,project_type,description,metadata")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    throw new Error("Project context could not be loaded.");
  }

  const [
    { data: globalBrain },
    { data: facts },
    { data: background },
    { data: findings },
    { data: bindings },
    { data: latestCrawl },
    { data: repositories },
    { data: serpEvidence },
    { data: gscSummary },
    { data: ga4Summary },
  ] = await Promise.all([
    supabase
      .from("global_brain_entries")
      .select("category,title,content,priority")
      .eq("owner_id", project.owner_id)
      .eq("active", true)
      .order("priority", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(30),
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
    supabase
      .from("crawl_runs")
      .select("id,crawl_type,status,summary,completed_at")
      .eq("project_id", projectId)
      .in("status", ["succeeded", "partial"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("project_repositories")
      .select("repo_full_name,default_branch,access_mode,status")
      .eq("project_id", projectId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(4),
    supabase
      .from("serp_checks")
      .select("keyword,location_code,language_code,status,result,checked_at")
      .eq("project_id", projectId)
      .eq("status", "succeeded")
      .order("checked_at", { ascending: false })
      .limit(20),
    supabase.rpc("get_gsc_agent_summary", {
      p_project_id: projectId,
      p_days: 28,
    }),
    supabase.rpc("get_ga4_agent_summary", {
      p_project_id: projectId,
      p_days: 28,
    }),
  ]);

  let crawlPages: Array<{
    url: string;
    status_code: number | null;
    title: string | null;
    canonical: string | null;
    robots_meta: string | null;
    h1s: unknown;
    word_count: number;
    internal_link_count: number;
    structured_data_count: number;
    fetch_error: string | null;
  }> = [];

  if (latestCrawl?.id) {
    const { data } = await supabase
      .from("crawl_pages")
      .select("url,status_code,title,canonical,robots_meta,h1s,word_count,internal_link_count,structured_data_count,fetch_error")
      .eq("crawl_run_id", latestCrawl.id)
      .order("word_count", { ascending: false })
      .limit(30);
    crawlPages = data || [];
  }

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
    global_brain: globalBrain || [],
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
    serp_evidence: (serpEvidence || []).map((item) => ({
      ...item,
      result: (item.result || {}) as Record<string, unknown>,
    })),
    repositories: repositories || [],
    warehouse_summary: {
      gsc: gscSummary ? (gscSummary as Record<string, unknown>) : null,
      ga4: ga4Summary ? (ga4Summary as Record<string, unknown>) : null,
    },
    latest_crawl: latestCrawl
      ? {
          id: latestCrawl.id,
          crawl_type: latestCrawl.crawl_type,
          status: latestCrawl.status,
          summary: (latestCrawl.summary || {}) as Record<string, unknown>,
          completed_at: latestCrawl.completed_at,
          pages: crawlPages,
        }
      : null,
    manifest: {
      fact_count: facts?.length || 0,
      background_chunk_count: background?.length || 0,
      finding_count: findings?.length || 0,
      binding_count: normalizedBindings.length,
      crawl_page_count: crawlPages.length,
    },
  };
}

export function contextToPrompt(context: AgentProjectContext) {
  const compact = {
    project: context.project,
    boundary: context.boundary,
    global_brain: context.global_brain,
    facts: context.facts,
    background: context.background,
    open_findings: context.findings,
    connected_resources: context.bindings,
    repository_bindings: context.repositories,
    latest_serp_evidence: context.serp_evidence,
    warehouse_summary_28d: context.warehouse_summary,
    latest_crawl: context.latest_crawl,
  };

  return JSON.stringify(compact, null, 2);
}
