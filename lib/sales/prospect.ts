import type { SupabaseClient } from "@supabase/supabase-js";
import { executeAgentTask } from "@/lib/agents/runtime";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
import { createReportingOutput } from "@/lib/outputs/reporting";
import { createClient } from "@/lib/supabase/server";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function convertSalesLeadToProspect(input: {
  ownerId: string;
  leadId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: lead, error } = await supabase
    .from("sales_leads")
    .select("id,domain,company_name,country,industry,stage,qualification_status,score,converted_project_id,evidence")
    .eq("id", input.leadId)
    .eq("owner_id", input.ownerId)
    .single();

  if (error || !lead) throw new Error(error?.message || "Lead not found.");
  if (lead.qualification_status === "rejected") {
    throw new Error("Rejected leads must be moved back to review before conversion.");
  }

  if (lead.converted_project_id) {
    return { projectId: lead.converted_project_id as string, created: false };
  }

  const name = lead.company_name?.trim() || lead.domain;
  const slug = (slugify(name) || "lead") + "-" + crypto.randomUUID().slice(0, 8);

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({
      owner_id: input.ownerId,
      name,
      slug,
      domain: lead.domain,
      project_type: "lead_prospect",
      status: "active",
      description:
        "Lead Prospect workspace created from the Sales pipeline. Use public/open information only. Do not claim access to private analytics, internal company strategy, roadmap, CRM data or other non-public context unless explicitly supplied later.",
    })
    .select("id")
    .single();

  if (projectError || !project) {
    throw new Error(projectError?.message || "Lead Prospect project could not be created.");
  }

  const { error: updateError } = await supabase
    .from("sales_leads")
    .update({
      converted_project_id: project.id,
      stage: lead.stage === "discovered" ? "qualified" : lead.stage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id)
    .eq("owner_id", input.ownerId);

  if (updateError) {
    await supabase.from("projects").delete().eq("id", project.id).eq("owner_id", input.ownerId);
    throw new Error(updateError.message);
  }

  await supabase.from("sales_events").insert({
    lead_id: lead.id,
    owner_id: input.ownerId,
    event_type: "converted_to_lead_prospect",
    summary: "Lead converted to a public-data-only Lead Prospect project.",
    metadata: {
      project_id: project.id,
      score: lead.score,
      country: lead.country,
      industry: lead.industry,
    },
  });

  return { projectId: project.id as string, created: true };
}

export async function auditSalesLeadProspect(input: {
  ownerId: string;
  leadId: string;
  maxUrls?: number;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: lead, error } = await supabase
    .from("sales_leads")
    .select("id,domain,company_name,converted_project_id")
    .eq("id", input.leadId)
    .eq("owner_id", input.ownerId)
    .single();

  if (error || !lead) throw new Error(error?.message || "Lead not found.");
  if (!lead.converted_project_id) {
    throw new Error("Convert this lead to a Lead Prospect project before running a prospect audit.");
  }

  const crawl = await runProjectCrawl({
    ownerId: input.ownerId,
    projectId: lead.converted_project_id,
    maxUrls: Math.min(Math.max(input.maxUrls || 50, 10), 150),
    crawlType: "prospect_audit",
    client: supabase,
  });

  const runId = await executeAgentTask({
    ownerId: input.ownerId,
    projectId: lead.converted_project_id,
    selectedAgentKey: "sales_lead",
    userRequest:
      "Review the latest public crawl evidence for this Lead Prospect. Select only saleable, evidence-backed findings. Separate verified public facts from third-party estimates and hypotheses. Explain likely business significance without inventing private analytics or internal company context. Recommend what belongs in a sales conversation and what should not be claimed.",
    triggerType: "manual",
    client: supabase,
  });

  await supabase
    .from("sales_leads")
    .update({
      stage: "audited",
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id)
    .eq("owner_id", input.ownerId);

  await supabase.from("sales_events").insert({
    lead_id: lead.id,
    owner_id: input.ownerId,
    event_type: "prospect_audit",
    summary: `Public prospect audit completed across ${String(crawl.summary.pages_crawled || 0)} pages.`,
    metadata: {
      project_id: lead.converted_project_id,
      crawl_run_id: crawl.runId,
      agent_run_id: runId,
      crawl_summary: crawl.summary,
    },
  });

  return {
    projectId: lead.converted_project_id as string,
    crawlRunId: crawl.runId,
    agentRunId: runId,
    summary: crawl.summary,
  };
}

export async function createSalesDeckForLead(input: {
  ownerId: string;
  leadId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: lead, error } = await supabase
    .from("sales_leads")
    .select("id,company_name,domain,converted_project_id,stage")
    .eq("id", input.leadId)
    .eq("owner_id", input.ownerId)
    .single();

  if (error || !lead) throw new Error(error?.message || "Lead not found.");
  if (!lead.converted_project_id) {
    throw new Error("Lead Prospect project is required before creating a sales deck.");
  }

  const generated = await createReportingOutput({
    ownerId: input.ownerId,
    projectId: lead.converted_project_id,
    format: "presentation",
    instruction:
      "Prepare a concise SEO sales presentation draft for this Lead Prospect using only approved public evidence and current project findings. Prioritize saleable findings, competitor/opportunity context, business significance, a practical roadmap and next steps. Do not invent traffic, revenue, internal strategy, budgets, first-party analytics or implementation history. Keep verified facts, estimates and hypotheses explicitly distinct.",
    triggerType: "manual",
    client: supabase,
  });

  await supabase.from("sales_events").insert({
    lead_id: lead.id,
    owner_id: input.ownerId,
    event_type: "sales_deck_created",
    summary: "Strict-profile sales presentation draft created.",
    metadata: {
      project_id: lead.converted_project_id,
      output_id: generated.outputId,
      agent_run_id: generated.runId,
    },
  });

  return generated;
}
