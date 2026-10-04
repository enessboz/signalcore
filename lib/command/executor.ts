import { executeAgentTask } from "@/lib/agents/runtime";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
import { runSerpResearch } from "@/lib/seo/run-serp-research";
import { enqueueGoogleSync } from "@/lib/google/sync";
import { createReportingOutput } from "@/lib/outputs/reporting";
import type { ChiefPlan } from "@/lib/command/chief";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSalesDiscoveryCampaign } from "@/lib/sales/discovery";
import { qualifyTopCampaignLeads } from "@/lib/sales/automation";
import { auditSalesLeadProspect, convertSalesLeadToProspect, createSalesDeckForLead } from "@/lib/sales/prospect";
import { convertLeadProspectProjectToClient } from "@/lib/projects/lifecycle";
import { runRankTrackingBatch, seedTrackedKeywordsFromGsc } from "@/lib/seo/rank-tracking";
import { detectWarehouseOpportunities } from "@/lib/rules/warehouse-opportunities";

type ChiefAction = ChiefPlan["actions"][number];

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function cleanDomain(value: string | null) {
  if (!value) return null;
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "") || null;
}

async function resolveProject(
  ownerId: string,
  projectRef: string | null,
  createdProjects: Map<string, string>,
) {
  if (!projectRef) return null;
  const normalized = projectRef.trim().toLowerCase();
  if (createdProjects.has(normalized)) return createdProjects.get(normalized)!;

  const supabase = await createClient();
  const { data: direct } = await supabase
    .from("projects")
    .select("id,name,domain")
    .eq("owner_id", ownerId)
    .eq("id", projectRef)
    .maybeSingle();

  if (direct?.id) return direct.id;

  const { data: projects } = await supabase
    .from("projects")
    .select("id,name,domain")
    .eq("owner_id", ownerId)
    .eq("status", "active");

  const exact = (projects || []).find((project) => {
    const name = project.name?.trim().toLowerCase();
    const domain = project.domain?.trim().toLowerCase();
    return name === normalized || domain === normalized;
  });

  if (exact) return exact.id;

  const contains = (projects || []).filter((project) => {
    const name = project.name?.trim().toLowerCase() || "";
    const domain = project.domain?.trim().toLowerCase() || "";
    return name.includes(normalized) || domain.includes(normalized);
  });

  return contains.length === 1 ? contains[0].id : null;
}

async function resolveSalesCampaign(
  supabase: SupabaseClient,
  ownerId: string,
  ref: string | null,
) {
  if (!ref) return null;
  const normalized = ref.trim().toLowerCase();

  const { data: direct } = await supabase
    .from("sales_campaigns")
    .select("id,name")
    .eq("owner_id", ownerId)
    .eq("id", ref)
    .maybeSingle();
  if (direct?.id) return direct;

  const { data: campaigns } = await supabase
    .from("sales_campaigns")
    .select("id,name")
    .eq("owner_id", ownerId)
    .neq("status", "archived");

  const exact = (campaigns || []).filter(
    (item) => item.name.trim().toLowerCase() === normalized,
  );
  if (exact.length === 1) return exact[0];

  const contains = (campaigns || []).filter((item) =>
    item.name.trim().toLowerCase().includes(normalized),
  );
  return contains.length === 1 ? contains[0] : null;
}

async function resolveSalesLead(
  supabase: SupabaseClient,
  ownerId: string,
  ref: string | null,
) {
  if (!ref) return null;
  const normalized = ref.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

  const { data: direct } = await supabase
    .from("sales_leads")
    .select("id,domain,company_name,stage,qualification_status,converted_project_id")
    .eq("owner_id", ownerId)
    .eq("id", ref)
    .maybeSingle();
  if (direct?.id) return direct;

  const { data: leads } = await supabase
    .from("sales_leads")
    .select("id,domain,company_name,stage,qualification_status,converted_project_id")
    .eq("owner_id", ownerId)
    .limit(500);

  const exact = (leads || []).filter((lead) => {
    const domain = lead.domain?.trim().toLowerCase();
    const name = lead.company_name?.trim().toLowerCase();
    return domain === normalized || name === normalized;
  });
  if (exact.length === 1) return exact[0];

  const contains = (leads || []).filter((lead) => {
    const domain = lead.domain?.trim().toLowerCase() || "";
    const name = lead.company_name?.trim().toLowerCase() || "";
    return domain.includes(normalized) || name.includes(normalized);
  });
  return contains.length === 1 ? contains[0] : null;
}

function chunkBackground(input: string, maxChars = 1500) {
  const paragraphs = input
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else if (paragraph.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [input.slice(0, maxChars)];
}

export type CommandActionResult = {
  type: ChiefAction["type"];
  status: "completed" | "failed" | "skipped";
  projectId?: string | null;
  targetAgentKey?: string | null;
  summary: string;
  data?: Record<string, unknown>;
};

export async function executeChiefActions(input: {
  ownerId: string;
  actions: ChiefPlan["actions"];
}) {
  const supabase = await createClient();
  const results: CommandActionResult[] = [];
  const createdProjects = new Map<string, string>();

  for (const action of input.actions) {
    if (action.type === "no_action") {
      results.push({
        type: action.type,
        status: "skipped",
        summary: "No internal action was required.",
      });
      continue;
    }

    try {
      if (action.type === "create_project") {
        const name = action.project_ref?.trim();
        if (!name || !action.project_type) {
          throw new Error("Project name and project type are required.");
        }

        const normalizedName = name.toLowerCase();
        const normalizedDomain = cleanDomain(action.domain);

        const { data: existing } = await supabase
          .from("projects")
          .select("id,name,domain")
          .eq("owner_id", input.ownerId)
          .eq("status", "active");

        const duplicate = (existing || []).find((project) => {
          return (
            project.name?.trim().toLowerCase() === normalizedName ||
            (normalizedDomain &&
              project.domain?.trim().toLowerCase() === normalizedDomain.toLowerCase())
          );
        });

        if (duplicate) {
          createdProjects.set(normalizedName, duplicate.id);
          if (normalizedDomain) createdProjects.set(normalizedDomain.toLowerCase(), duplicate.id);
          results.push({
            type: action.type,
            status: "completed",
            projectId: duplicate.id,
            summary: `Project already exists: ${duplicate.name}.`,
          });
          continue;
        }

        const baseSlug = slugify(name) || "project";
        const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;

        const { data: project, error } = await supabase
          .from("projects")
          .insert({
            owner_id: input.ownerId,
            name,
            slug,
            domain: normalizedDomain,
            project_type: action.project_type,
            description: action.description || null,
          })
          .select("id,name,domain")
          .single();

        if (error || !project) {
          throw new Error(error?.message || "Project could not be created.");
        }

        createdProjects.set(normalizedName, project.id);
        if (normalizedDomain) createdProjects.set(normalizedDomain.toLowerCase(), project.id);

        results.push({
          type: action.type,
          status: "completed",
          projectId: project.id,
          summary: `Created ${project.name} as a ${action.project_type.replace("_", " ")} project.`,
          data: { domain: project.domain },
        });
        continue;
      }

      if (action.type === "add_global_brain_entry") {
        const title = action.entry_title?.trim();
        const content = action.entry_content?.trim();
        const category = action.brain_category || "rule";

        if (!title || !content || content.length < 10) {
          throw new Error("Global Brain entry needs a title and meaningful content.");
        }

        const { data: entry, error } = await supabase
          .from("global_brain_entries")
          .insert({
            owner_id: input.ownerId,
            category,
            title,
            content,
            priority: Math.min(Math.max(action.priority ?? 80, 0), 100),
            active: true,
          })
          .select("id,title")
          .single();

        if (error || !entry) {
          throw new Error(error?.message || "Global Brain entry could not be created.");
        }

        results.push({
          type: action.type,
          status: "completed",
          summary: `Added Global Brain rule: ${entry.title}.`,
          data: { entry_id: entry.id, category },
        });
        continue;
      }

      if (action.type === "create_sales_campaign") {
        const name = action.campaign_name?.trim() || action.campaign_ref?.trim();
        const queries = Array.from(
          new Set((action.sales_queries || []).map((item) => item.trim()).filter(Boolean)),
        ).slice(0, 20);

        if (!name || !queries.length) {
          throw new Error("Sales campaign needs a name and at least one discovery query.");
        }

        const existing = await resolveSalesCampaign(supabase, input.ownerId, name);
        if (existing) {
          results.push({
            type: action.type,
            status: "completed",
            summary: "Sales campaign already exists: " + existing.name + ".",
            data: { campaign_id: existing.id },
          });
          continue;
        }

        const { data: campaign, error } = await supabase
          .from("sales_campaigns")
          .insert({
            owner_id: input.ownerId,
            name,
            status: "draft",
            country: action.country || null,
            industry: action.industry || null,
            location_code: action.location_code || 2840,
            language_code: action.language_code || "en",
            queries,
            exclusions: (action.exclusions || []).slice(0, 50),
            depth: 20,
            min_score: action.min_score ?? 65,
            max_candidates: action.max_candidates ?? 100,
            max_run_cost_usd: action.max_run_cost ?? 0.25,
          })
          .select("id,name")
          .single();

        if (error || !campaign) {
          throw new Error(error?.message || "Sales campaign could not be created.");
        }

        results.push({
          type: action.type,
          status: "completed",
          summary: "Created Sales discovery campaign " + campaign.name + ".",
          data: { campaign_id: campaign.id, queries: queries.length },
        });
        continue;
      }

      if (action.type === "run_sales_campaign") {
        const campaign = await resolveSalesCampaign(
          supabase,
          input.ownerId,
          action.campaign_ref || action.campaign_name,
        );
        if (!campaign) throw new Error("Sales campaign could not be uniquely resolved.");

        const run = await runSalesDiscoveryCampaign({
          ownerId: input.ownerId,
          campaignId: campaign.id,
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          summary:
            "Sales discovery completed for " +
            campaign.name +
            ": " +
            String(run.uniqueCandidates) +
            " candidates, " +
            String(run.leadsCreated) +
            " new leads.",
          data: {
            campaign_id: campaign.id,
            run_id: run.runId,
            cost: run.actualCost,
            unique_candidates: run.uniqueCandidates,
          },
        });
        continue;
      }

      if (action.type === "qualify_sales_campaign") {
        const campaign = await resolveSalesCampaign(
          supabase,
          input.ownerId,
          action.campaign_ref || action.campaign_name,
        );
        if (!campaign) throw new Error("Sales campaign could not be uniquely resolved.");

        const qualification = await qualifyTopCampaignLeads({
          ownerId: input.ownerId,
          campaignId: campaign.id,
          limit: action.auto_qualify_count || 10,
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          summary:
            "Qualified " +
            String(qualification.succeeded) +
            "/" +
            String(qualification.requested) +
            " top leads for " +
            campaign.name +
            ".",
          data: { campaign_id: campaign.id, ...qualification },
        });
        continue;
      }

      if (action.type === "configure_sales_automation") {
        const campaign = await resolveSalesCampaign(
          supabase,
          input.ownerId,
          action.campaign_ref || action.campaign_name,
        );
        if (!campaign) throw new Error("Sales campaign could not be uniquely resolved.");

        const enabled = action.enabled ?? true;
        const kind = action.schedule_kind;
        if (enabled && (!kind || kind === "once" || !action.time_local)) {
          throw new Error("Sales automation requires daily/weekly/monthly cadence and local time.");
        }
        if (enabled && kind === "weekly" && !(action.days_of_week || []).length) {
          throw new Error("Weekly Sales automation requires days_of_week.");
        }

        const scheduleConfig = {
          time_local: action.time_local,
          days_of_week: kind === "weekly" ? action.days_of_week || [] : [],
          day_of_month: kind === "monthly" ? action.day_of_month || 1 : null,
        };

        const { error } = await supabase
          .from("sales_campaigns")
          .update({
            auto_discovery_enabled: enabled,
            schedule_kind: kind === "once" ? null : kind,
            schedule_config: scheduleConfig,
            timezone: action.timezone || "Europe/Istanbul",
            auto_qualify_count: Math.min(Math.max(action.auto_qualify_count || 0, 0), 10),
            last_auto_status: enabled ? "idle" : "paused",
            last_auto_error: null,
            status: enabled ? "active" : undefined,
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaign.id)
          .eq("owner_id", input.ownerId);

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          summary:
            "Sales automation " +
            (enabled ? "enabled" : "disabled") +
            " for " +
            campaign.name +
            ".",
          data: {
            campaign_id: campaign.id,
            enabled,
            schedule: scheduleConfig,
          },
        });
        continue;
      }

      if (
        ["convert_sales_lead", "audit_sales_lead", "create_sales_deck"].includes(
          action.type,
        )
      ) {
        const lead = await resolveSalesLead(
          supabase,
          input.ownerId,
          action.lead_ref || action.domain,
        );
        if (!lead) throw new Error("Sales lead could not be uniquely resolved.");

        if (action.type === "convert_sales_lead") {
          const converted = await convertSalesLeadToProspect({
            ownerId: input.ownerId,
            leadId: lead.id,
            client: supabase,
          });
          results.push({
            type: action.type,
            status: "completed",
            projectId: converted.projectId,
            summary:
              (converted.created ? "Converted" : "Resolved") +
              " " +
              (lead.company_name || lead.domain) +
              " as a Lead Prospect project.",
            data: { lead_id: lead.id, project_id: converted.projectId },
          });
          continue;
        }

        if (action.type === "audit_sales_lead") {
          const audited = await auditSalesLeadProspect({
            ownerId: input.ownerId,
            leadId: lead.id,
            maxUrls: action.max_urls || 50,
            client: supabase,
          });
          results.push({
            type: action.type,
            status: "completed",
            projectId: audited.projectId,
            targetAgentKey: "sales_lead",
            summary:
              "Completed public prospect audit for " +
              (lead.company_name || lead.domain) +
              ".",
            data: {
              lead_id: lead.id,
              crawl_run_id: audited.crawlRunId,
              agent_run_id: audited.agentRunId,
            },
          });
          continue;
        }

        const deck = await createSalesDeckForLead({
          ownerId: input.ownerId,
          leadId: lead.id,
          client: supabase,
        });
        results.push({
          type: action.type,
          status: "completed",
          projectId: lead.converted_project_id,
          targetAgentKey: "reporting_output",
          summary:
            "Created strict-profile Sales deck draft for " +
            (lead.company_name || lead.domain) +
            ".",
          data: {
            lead_id: lead.id,
            output_id: deck.outputId,
            run_id: deck.runId,
          },
        });
        continue;
      }

      const projectId = await resolveProject(
        input.ownerId,
        action.project_ref,
        createdProjects,
      );

      if (
        [
          "delegate_agent",
          "create_ga4_funnel",
          "schedule_agent_task",
          "request_report",
          "run_technical_audit",
          "run_prospect_audit",
          "link_github_repo",
          "run_serp_research",
          "set_google_auto_sync",
          "queue_google_backfill",
          "add_project_background",
          "assign_output_profile",
          "set_budget_limit",
          "convert_project_to_client",
          "create_technical_crawl_schedule",
          "manage_technical_crawl_schedule",
          "configure_rank_tracking",
          "add_tracked_keywords",
          "seed_rank_from_gsc",
          "run_rank_tracking",
          "configure_opportunity_engine",
          "run_opportunity_scan",
        ].includes(action.type) &&
        !projectId
      ) {
        throw new Error(
          `Project could not be resolved from "${action.project_ref || "empty reference"}".`,
        );
      }

      if (action.type === "add_project_background") {
        const title = action.background_title?.trim() || "Chief Operator Background";
        const content = action.background_content?.trim();
        if (!content || content.length < 20) {
          throw new Error("Project background needs at least 20 characters of user-supplied content.");
        }

        const { data: source, error: sourceError } = await supabase
          .from("project_sources")
          .insert({
            project_id: projectId!,
            owner_id: input.ownerId,
            source_type: "manual_background",
            title,
            content_text: content,
            metadata: { source: "chief_operator", char_count: content.length },
          })
          .select("id")
          .single();

        if (sourceError || !source) {
          throw new Error(sourceError?.message || "Project background could not be saved.");
        }

        const chunks = chunkBackground(content);
        const { error: chunkError } = await supabase
          .from("background_chunks")
          .insert(
            chunks.map((chunk, index) => ({
              source_id: source.id,
              project_id: projectId!,
              owner_id: input.ownerId,
              chunk_index: index,
              content: chunk,
              metadata: { char_count: chunk.length, source: "chief_operator" },
            })),
          );

        if (chunkError) {
          await supabase.from("project_sources").delete().eq("id", source.id);
          throw new Error(chunkError.message);
        }

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: `Added "${title}" to Project Brain with ${chunks.length} searchable chunk(s).`,
          data: { source_id: source.id, chunks: chunks.length },
        });
        continue;
      }

      if (action.type === "assign_output_profile") {
        const outputType = action.output_type;
        const profileRef = action.output_profile_ref?.trim();
        if (!outputType || !profileRef) {
          throw new Error("Output type and output profile name/key are required.");
        }

        const { data: profiles } = await supabase
          .from("output_profiles")
          .select("id,profile_key,name,output_type")
          .eq("owner_id", input.ownerId)
          .eq("active", true)
          .eq("output_type", outputType);

        const normalized = profileRef.toLowerCase();
        const matches = (profiles || []).filter(
          (profile) =>
            profile.profile_key.toLowerCase() === normalized ||
            profile.name.toLowerCase() === normalized ||
            profile.name.toLowerCase().includes(normalized),
        );

        if (matches.length !== 1) {
          throw new Error(
            matches.length
              ? "Output profile reference is ambiguous."
              : `No active ${outputType} profile matches "${profileRef}".`,
          );
        }

        const { error } = await supabase.from("project_output_profiles").upsert(
          {
            project_id: projectId!,
            owner_id: input.ownerId,
            output_type: outputType,
            profile_id: matches[0].id,
          },
          { onConflict: "project_id,output_type" },
        );

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: `Assigned ${matches[0].name} as the project's ${outputType} profile.`,
          data: { profile_id: matches[0].id, output_type: outputType },
        });
        continue;
      }

      if (action.type === "set_budget_limit") {
        const category = action.budget_category;
        const monthlyLimit = action.monthly_limit;
        if (
          !category ||
          monthlyLimit === null ||
          monthlyLimit < 0
        ) {
          throw new Error("Budget category and non-negative monthly limit are required.");
        }

        const warning = Math.min(
          Math.max(action.soft_warning_percent ?? 80, 1),
          100,
        );

        const { error } = await supabase.from("budget_limits").upsert(
          {
            project_id: projectId!,
            owner_id: input.ownerId,
            category,
            monthly_limit: monthlyLimit,
            soft_warning_percent: warning,
            hard_stop: action.hard_stop ?? true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id,category" },
        );

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: `Set ${category.toUpperCase()} monthly budget to ${monthlyLimit.toFixed(2)} (${action.hard_stop ?? true ? "hard stop" : "warning only"}).`,
          data: {
            category,
            monthly_limit: monthlyLimit,
            soft_warning_percent: warning,
            hard_stop: action.hard_stop ?? true,
          },
        });
        continue;
      }

      if (action.type === "set_google_auto_sync") {
        const source = action.data_source;
        if (!source || action.enabled === null) {
          throw new Error("Data source and enabled state are required.");
        }

        const { data: binding, error: bindingError } = await supabase
          .from("project_bindings")
          .select("id")
          .eq("project_id", projectId!)
          .eq("owner_id", input.ownerId)
          .eq("binding_type", source)
          .eq("binding_role", "primary")
          .maybeSingle();

        if (bindingError || !binding) {
          throw new Error(
            `${source.toUpperCase()} property must be bound before auto sync can be changed.`,
          );
        }

        const { error } = await supabase
          .from("project_bindings")
          .update({
            auto_sync_enabled: action.enabled,
            updated_at: new Date().toISOString(),
          })
          .eq("id", binding.id)
          .eq("owner_id", input.ownerId);

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: `${source.toUpperCase()} auto sync ${action.enabled ? "enabled" : "disabled"}.`,
          data: { source, enabled: action.enabled },
        });
        continue;
      }

      if (action.type === "queue_google_backfill") {
        const source = action.data_source;
        const days = action.backfill_days;
        if (!source || !days || ![30, 90, 180, 480].includes(days)) {
          throw new Error(
            "Backfill requires GSC/GA4 source and 30, 90, 180 or 480 days.",
          );
        }

        const { data: binding, error: bindingError } = await supabase
          .from("project_bindings")
          .select("id")
          .eq("project_id", projectId!)
          .eq("owner_id", input.ownerId)
          .eq("binding_type", source)
          .eq("binding_role", "primary")
          .maybeSingle();

        if (bindingError || !binding) {
          throw new Error(
            `${source.toUpperCase()} property must be bound before backfill can be queued.`,
          );
        }

        const lagDays = source === "gsc" ? 3 : 1;
        const endDate = new Date(Date.now() - lagDays * 86400000)
          .toISOString()
          .slice(0, 10);
        const startDate = new Date(
          Date.now() - (lagDays + days - 1) * 86400000,
        )
          .toISOString()
          .slice(0, 10);

        const jobId = await enqueueGoogleSync({
          ownerId: input.ownerId,
          projectId: projectId!,
          source,
          startDate,
          endDate,
          mode: "backfill",
          priority: 60,
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: `${source.toUpperCase()} ${days}-day backfill queued.`,
          data: { source, days, job_id: jobId, start_date: startDate, end_date: endDate },
        });
        continue;
      }

      if (action.type === "create_technical_crawl_schedule") {
        const title =
          action.schedule_name?.trim() ||
          (action.crawl_mode === "delta"
            ? "Daily Delta Crawl"
            : "Weekly Full Crawl");
        const kind = action.schedule_kind;
        const crawlMode = action.crawl_mode || "http";

        if (!kind || kind === "once") {
          throw new Error(
            "Technical crawl schedules require daily, weekly or monthly cadence.",
          );
        }
        if (!action.time_local) {
          throw new Error("Technical crawl schedule requires time_local.");
        }
        if (kind === "weekly" && !(action.days_of_week || []).length) {
          throw new Error("Weekly technical crawl requires days_of_week.");
        }

        const scheduleConfig = {
          time_local: action.time_local,
          days_of_week: kind === "weekly" ? action.days_of_week || [] : [],
          day_of_month: kind === "monthly" ? action.day_of_month || 1 : null,
        };

        const { data: schedule, error } = await supabase
          .from("technical_crawl_schedules")
          .upsert(
            {
              owner_id: input.ownerId,
              project_id: projectId!,
              name: title,
              crawl_type: crawlMode,
              max_urls: Math.min(
                Math.max(action.max_urls || (crawlMode === "delta" ? 50 : 500), 1),
                500,
              ),
              schedule_kind: kind,
              schedule_config: scheduleConfig,
              timezone: action.timezone || "Europe/Istanbul",
              status: "active",
              last_status: "idle",
              last_error: null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id,name" },
          )
          .select("id,name,crawl_type,max_urls")
          .single();

        if (error || !schedule) {
          throw new Error(
            error?.message || "Technical crawl schedule could not be created.",
          );
        }

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "Saved " +
            schedule.name +
            " (" +
            schedule.crawl_type +
            ", " +
            String(schedule.max_urls) +
            " URLs).",
          data: {
            schedule_id: schedule.id,
            crawl_mode: schedule.crawl_type,
            max_urls: schedule.max_urls,
            schedule: scheduleConfig,
          },
        });
        continue;
      }

      if (action.type === "manage_technical_crawl_schedule") {
        const scheduleName = action.schedule_name?.trim();
        const status = action.schedule_status;

        if (!scheduleName || !status) {
          throw new Error(
            "Technical crawl schedule name and desired status are required.",
          );
        }

        const { data: schedules, error: scheduleError } = await supabase
          .from("technical_crawl_schedules")
          .select("id,name,status")
          .eq("owner_id", input.ownerId)
          .eq("project_id", projectId!)
          .neq("status", "cancelled");

        if (scheduleError) throw new Error(scheduleError.message);

        const normalized = scheduleName.toLowerCase();
        const matches = (schedules || []).filter((schedule) => {
          const name = schedule.name.trim().toLowerCase();
          return name === normalized || name.includes(normalized);
        });
        const target =
          matches.length === 1
            ? matches[0]
            : (schedules || []).find(
                (schedule) =>
                  schedule.name.trim().toLowerCase() === normalized,
              );

        if (!target) {
          throw new Error(
            'Technical crawl schedule "' +
              scheduleName +
              '" could not be uniquely resolved.',
          );
        }

        const { error } = await supabase
          .from("technical_crawl_schedules")
          .update({
            status,
            last_status: status === "paused" ? "paused" : undefined,
            updated_at: new Date().toISOString(),
          })
          .eq("id", target.id)
          .eq("owner_id", input.ownerId)
          .eq("project_id", projectId!);

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            'Technical crawl schedule "' +
            target.name +
            '" is now ' +
            status +
            ".",
          data: { schedule_id: target.id, status },
        });
        continue;
      }

      if (action.type === "configure_rank_tracking") {
        const { data: existing } = await supabase
          .from("rank_tracking_settings")
          .select("active,auto_discover_enabled,auto_findings_enabled,max_auto_keywords,min_impressions_28d,position_min,position_max,default_location_code,default_language_code,default_device,daily_high_priority_limit")
          .eq("project_id", projectId!)
          .eq("owner_id", input.ownerId)
          .maybeSingle();

        const positionMin = action.position_min ?? Number(existing?.position_min ?? 1);
        const positionMax = action.position_max ?? Number(existing?.position_max ?? 30);
        if (positionMax < positionMin) {
          throw new Error("Rank tracking position_max must be greater than or equal to position_min.");
        }

        const { error } = await supabase.from("rank_tracking_settings").upsert(
          {
            project_id: projectId!,
            owner_id: input.ownerId,
            active: action.enabled ?? existing?.active ?? true,
            auto_discover_enabled:
              action.rank_auto_discover ?? existing?.auto_discover_enabled ?? false,
            auto_findings_enabled:
              action.rank_auto_findings ?? existing?.auto_findings_enabled ?? true,
            max_auto_keywords:
              action.max_auto_keywords ?? existing?.max_auto_keywords ?? 100,
            min_impressions_28d:
              action.min_impressions ?? existing?.min_impressions_28d ?? 100,
            position_min: positionMin,
            position_max: positionMax,
            default_location_code:
              action.location_code ?? existing?.default_location_code ?? 2840,
            default_language_code:
              action.language_code ?? existing?.default_language_code ?? "en",
            default_device:
              action.rank_device ?? existing?.default_device ?? "desktop",
            daily_high_priority_limit:
              action.daily_high_priority_limit ??
              existing?.daily_high_priority_limit ??
              20,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id" },
        );

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "Rank Tracking settings updated" +
            (action.rank_auto_discover ? " with GSC auto-discovery enabled." : "."),
          data: {
            active: action.enabled ?? existing?.active ?? true,
            auto_discover:
              action.rank_auto_discover ?? existing?.auto_discover_enabled ?? false,
            max_auto_keywords:
              action.max_auto_keywords ?? existing?.max_auto_keywords ?? 100,
            position_range: [positionMin, positionMax],
          },
        });
        continue;
      }

      if (action.type === "add_tracked_keywords") {
        const keywords = Array.from(
          new Set(
            (action.keywords || [])
              .map((keyword) => keyword.trim())
              .filter(Boolean),
          ),
        ).slice(0, 50);

        if (!keywords.length) {
          throw new Error("At least one keyword is required for Rank Tracking.");
        }

        const { data: settings } = await supabase
          .from("rank_tracking_settings")
          .select("default_location_code,default_language_code,default_device")
          .eq("project_id", projectId!)
          .eq("owner_id", input.ownerId)
          .maybeSingle();

        const rows = keywords.map((keyword) => ({
          project_id: projectId!,
          owner_id: input.ownerId,
          keyword,
          source: "manual",
          priority: action.rank_priority || "normal",
          cadence: action.rank_cadence || "weekly",
          depth: action.rank_depth || 30,
          location_code:
            action.location_code ?? settings?.default_location_code ?? 2840,
          language_code:
            action.language_code ?? settings?.default_language_code ?? "en",
          device: action.rank_device ?? settings?.default_device ?? "desktop",
          active: true,
          updated_at: new Date().toISOString(),
        }));

        const { error } = await supabase.from("tracked_keywords").upsert(rows, {
          onConflict: "project_id,keyword,location_code,language_code,device",
        });
        if (error) throw new Error(error.message);

        await supabase.from("rank_tracking_settings").upsert(
          {
            project_id: projectId!,
            owner_id: input.ownerId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id" },
        );

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "Added " +
            String(keywords.length) +
            " keyword(s) to Rank Tracking.",
          data: { keywords },
        });
        continue;
      }

      if (action.type === "seed_rank_from_gsc") {
        const seeded = await seedTrackedKeywordsFromGsc({
          ownerId: input.ownerId,
          projectId: projectId!,
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "GSC Rank Tracker seed completed: " +
            String(seeded.inserted) +
            " new keyword(s) from " +
            String(seeded.candidates) +
            " candidate(s).",
          data: seeded,
        });
        continue;
      }

      if (action.type === "run_rank_tracking") {
        let keywordIds: string[] | undefined;

        if ((action.keywords || []).length) {
          const requested = new Set(
            action.keywords.map((keyword) => keyword.trim().toLowerCase()),
          );
          const { data: rows, error } = await supabase
            .from("tracked_keywords")
            .select("id,keyword")
            .eq("project_id", projectId!)
            .eq("owner_id", input.ownerId)
            .eq("active", true)
            .limit(1000);
          if (error) throw new Error(error.message);

          keywordIds = (rows || [])
            .filter((row) => requested.has(row.keyword.trim().toLowerCase()))
            .map((row) => row.id);

          if (!keywordIds.length) {
            throw new Error(
              "None of the requested keywords are currently tracked in this project.",
            );
          }
        }

        const rankRun = await runRankTrackingBatch({
          ownerId: input.ownerId,
          projectId: projectId!,
          keywordIds,
          triggerType: "chief",
          limit: keywordIds?.length || 10,
          onlyDue: false,
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "Rank check completed: " +
            String(rankRun.succeeded) +
            " succeeded, " +
            String(rankRun.failed) +
            " failed, cost $" +
            Number(rankRun.actualCost || 0).toFixed(4) +
            ".",
          data: {
            run_id: rankRun.runId,
            requested: rankRun.requested,
            succeeded: rankRun.succeeded,
            failed: rankRun.failed,
            actual_cost: rankRun.actualCost,
          },
        });
        continue;
      }

      if (action.type === "configure_opportunity_engine") {
        const { data: existing } = await supabase
          .from("opportunity_scan_settings")
          .select("enabled,scan_gsc,scan_ga4,scan_rank,cadence")
          .eq("project_id", projectId!)
          .eq("owner_id", input.ownerId)
          .maybeSingle();

        const enabled = action.enabled ?? existing?.enabled ?? true;
        const scanGsc = action.scan_gsc ?? existing?.scan_gsc ?? true;
        const scanGa4 = action.scan_ga4 ?? existing?.scan_ga4 ?? true;
        const scanRank = action.scan_rank ?? existing?.scan_rank ?? true;

        if (enabled && !scanGsc && !scanGa4 && !scanRank) {
          throw new Error(
            "Opportunity Engine requires at least one enabled evidence source.",
          );
        }

        const { error } = await supabase.from("opportunity_scan_settings").upsert(
          {
            project_id: projectId!,
            owner_id: input.ownerId,
            enabled,
            scan_gsc: scanGsc,
            scan_ga4: scanGa4,
            scan_rank: scanRank,
            cadence: action.opportunity_cadence ?? existing?.cadence ?? "daily",
            last_status: enabled ? "idle" : "paused",
            last_error: null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id" },
        );
        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "Opportunity Engine " +
            (enabled ? "enabled" : "paused") +
            " for the project.",
          data: {
            enabled,
            scan_gsc: scanGsc,
            scan_ga4: scanGa4,
            scan_rank: scanRank,
            cadence: action.opportunity_cadence ?? existing?.cadence ?? "daily",
          },
        });
        continue;
      }

      if (action.type === "run_opportunity_scan") {
        const { data: settings } = await supabase
          .from("opportunity_scan_settings")
          .select("scan_gsc,scan_ga4,scan_rank")
          .eq("project_id", projectId!)
          .eq("owner_id", input.ownerId)
          .maybeSingle();

        const scan = await detectWarehouseOpportunities({
          ownerId: input.ownerId,
          projectId: projectId!,
          scanGsc: settings?.scan_gsc !== false,
          scanGa4: settings?.scan_ga4 !== false,
          scanRank: settings?.scan_rank !== false,
          client: supabase,
        });

        await supabase.from("opportunity_scan_settings").upsert(
          {
            project_id: projectId!,
            owner_id: input.ownerId,
            last_run_at: new Date().toISOString(),
            last_data_date: scan.dataDate,
            last_status:
              scan.gscAvailable || scan.ga4Available ? "succeeded" : "partial",
            last_error: null,
            consecutive_failures: 0,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "project_id" },
        );

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary:
            "Opportunity scan completed: " +
            String(scan.candidates) +
            " candidates, " +
            String(scan.high) +
            " high importance.",
          data: scan,
        });
        continue;
      }

      if (action.type === "convert_project_to_client") {
        const converted = await convertLeadProspectProjectToClient({
          ownerId: input.ownerId,
          projectId: projectId!,
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: converted.changed
            ? "Lead Prospect converted to Client workspace."
            : "Project is already a Client workspace.",
          data: { project_id: projectId, changed: converted.changed },
        });
        continue;
      }

      if (action.type === "run_serp_research") {
        const keywords = action.keywords.map((keyword) => keyword.trim()).filter(Boolean);
        if (!keywords.length) throw new Error("SERP research requires at least one keyword.");

        const research = await runSerpResearch({
          ownerId: input.ownerId,
          projectId: projectId!,
          keywords,
          locationCode: action.location_code || 2840,
          languageCode: action.language_code || "en",
        });

        if (!research.succeeded) {
          throw new Error(
            research.results.find((item) => item.error)?.error ||
              "SERP research could not retrieve any successful results.",
          );
        }

        const task =
          action.task?.trim() ||
          "Analyze the latest cached SERP evidence. Identify intent patterns, competitor coverage, content gaps and practical landing-page opportunities. Separate observed SERP facts from strategic hypotheses.";

        const runId = await executeAgentTask({
          ownerId: input.ownerId,
          projectId: projectId!,
          selectedAgentKey: "research_content",
          userRequest: task,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "research_content",
          summary:
            "SERP research completed for " +
            String(research.succeeded) +
            " keyword(s) and handed to Research & Content Strategy Agent.",
          data: {
            agent_run_id: runId,
            keywords,
            estimated_cost: research.estimatedCost,
          },
        });
        continue;
      }

      if (action.type === "link_github_repo") {
        const repoFullName = action.repo_full_name?.trim();
        if (!repoFullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
          throw new Error("A valid GitHub repo in owner/repo format is required.");
        }

        const { data: repository, error } = await supabase
          .from("project_repositories")
          .upsert(
            {
              project_id: projectId!,
              owner_id: input.ownerId,
              provider: "github",
              repo_full_name: repoFullName,
              access_mode: "read_only",
              status: "active",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id,provider,repo_full_name" },
          )
          .select("id,repo_full_name")
          .single();

        if (error || !repository) {
          throw new Error(error?.message || "GitHub repository could not be linked.");
        }

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "developer",
          summary: `Linked GitHub repository ${repository.repo_full_name} in read-only mode.`,
          data: { repository_id: repository.id, repo_full_name: repository.repo_full_name },
        });
        continue;
      }

      if (action.type === "run_technical_audit") {
        const crawl = await runProjectCrawl({
          ownerId: input.ownerId,
          projectId: projectId!,
          maxUrls: Math.min(Math.max(action.max_urls || 100, 1), 500),
          crawlType: "http",
        });

        const task =
          action.task?.trim() ||
          "Review the latest deterministic HTTP crawl evidence, prioritize the technical SEO issues, explain why they matter, and recommend validation steps before implementation.";

        const runId = await executeAgentTask({
          ownerId: input.ownerId,
          projectId: projectId!,
          selectedAgentKey: "technical_seo",
          userRequest: task,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "technical_seo",
          summary:
            "Technical audit completed: " +
            String(crawl.summary.pages_crawled || 0) +
            " pages crawled and handed to Technical SEO Agent.",
          data: { crawl_run_id: crawl.runId, agent_run_id: runId, crawl_summary: crawl.summary },
        });
        continue;
      }

      if (action.type === "run_prospect_audit") {
        const crawl = await runProjectCrawl({
          ownerId: input.ownerId,
          projectId: projectId!,
          maxUrls: Math.min(Math.max(action.max_urls || 50, 1), 150),
          crawlType: "prospect_audit",
        });

        const task =
          action.task?.trim() ||
          "Review the latest public crawl evidence for this Lead Prospect. Select only saleable, evidence-backed findings, explain the likely business significance, and identify what should go into a sales narrative. Do not claim access to private analytics or internal company information.";

        const runId = await executeAgentTask({
          ownerId: input.ownerId,
          projectId: projectId!,
          selectedAgentKey: "sales_lead",
          userRequest: task,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "sales_lead",
          summary:
            "Prospect audit completed: " +
            String(crawl.summary.pages_crawled || 0) +
            " public pages crawled and handed to Sales Lead Agent.",
          data: { crawl_run_id: crawl.runId, agent_run_id: runId, crawl_summary: crawl.summary },
        });
        continue;
      }

      if (action.type === "delegate_agent") {
        const task = action.task?.trim();
        if (!task) throw new Error("Delegated task is empty.");

        const selectedAgent = action.agent_key || "auto";
        const runId = await executeAgentTask({
          ownerId: input.ownerId,
          projectId: projectId!,
          selectedAgentKey: selectedAgent,
          userRequest: task,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: selectedAgent,
          summary: `Delegated task to ${selectedAgent === "auto" ? "Router / Orchestrator" : selectedAgent}.`,
          data: { run_id: runId },
        });
        continue;
      }

      if (action.type === "request_report") {
        const task =
          action.task?.trim() ||
          "Prepare a concise report from the current approved project findings and evidence.";
        const format = action.report_format || "summary";

        const generated = await createReportingOutput({
          ownerId: input.ownerId,
          projectId: projectId!,
          format,
          instruction: task,
          triggerType: "manual",
          client: supabase,
        });

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "reporting_output",
          summary: `Reporting Agent created a ${format} draft: ${generated.title}.`,
          data: {
            run_id: generated.runId,
            output_id: generated.outputId,
            format: generated.format,
          },
        });
        continue;
      }

      if (action.type === "create_ga4_funnel") {
        const funnelName = action.funnel_name?.trim();
        const steps = action.funnel_steps.filter(
          (step) => step.name.trim() && step.event_name.trim(),
        );

        if (!funnelName || steps.length < 2) {
          throw new Error("A GA4 funnel requires a name and at least two event steps.");
        }

        const { data: funnel, error } = await supabase
          .from("ga4_funnels")
          .insert({
            project_id: projectId!,
            owner_id: input.ownerId,
            name: funnelName,
            description: action.description || null,
            config: {
              mode: "funnel",
              steps: steps.map((step) => ({
                name: step.name.trim(),
                eventName: step.event_name.trim(),
              })),
              breakdown: action.breakdown_dimension || "",
              openFunnel: Boolean(action.open_funnel),
            },
          })
          .select("id,name")
          .single();

        if (error || !funnel) {
          throw new Error(error?.message || "GA4 funnel could not be saved.");
        }

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          summary: `Saved GA4 funnel "${funnel.name}" with ${steps.length} steps.`,
          data: { funnel_id: funnel.id },
        });
        continue;
      }

      if (action.type === "schedule_agent_task") {
        const title = action.schedule_name?.trim() || action.task?.trim().slice(0, 80);
        const task = action.task?.trim();
        const kind = action.schedule_kind;
        const agentKey = action.agent_key || "auto";

        if (!title || !task || !kind) {
          throw new Error("Scheduled task needs a title, instruction and schedule.");
        }

        const timezone = action.timezone || "Europe/Istanbul";
        const scheduleConfig = {
          run_at: action.run_at,
          time_local: action.time_local,
          days_of_week: action.days_of_week || [],
          day_of_month: action.day_of_month,
          window_end_local: action.window_end_local,
        };

        if (kind === "once" && !action.run_at) {
          throw new Error("A one-time schedule requires run_at.");
        }
        if (kind !== "once" && !action.time_local) {
          throw new Error("A recurring schedule requires time_local.");
        }

        const { data: scheduled, error } = await supabase
          .from("scheduled_tasks")
          .insert({
            owner_id: input.ownerId,
            project_id: projectId,
            title,
            instruction: task,
            target_agent_key: agentKey === "auto" ? "router_orchestrator" : agentKey,
            schedule_kind: kind,
            schedule_config: scheduleConfig,
            post_run_config: action.follow_up_report
              ? {
                  report_on_importance: true,
                  minimum_importance: action.minimum_importance || "high",
                  report_format: action.report_format || "summary",
                }
              : {},
            timezone,
            status: "active",
            next_run_at: kind === "once" ? action.run_at : null,
          })
          .select("id,title")
          .single();

        if (error || !scheduled) {
          throw new Error(error?.message || "Scheduled task could not be created.");
        }

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: agentKey,
          summary: `Scheduled "${scheduled.title}" (${kind}, ${timezone}).`,
          data: {
            scheduled_task_id: scheduled.id,
            schedule: scheduleConfig,
            post_run: action.follow_up_report
              ? {
                  report_on_importance: true,
                  minimum_importance: action.minimum_importance || "high",
                  report_format: action.report_format || "summary",
                }
              : {},
          },
        });
        continue;
      }

      if (action.type === "manage_schedule") {
        const scheduleName = action.schedule_name?.trim();
        const status = action.schedule_status;
        if (!scheduleName || !status) {
          throw new Error("Schedule name and desired status are required.");
        }

        const { data: schedules } = await supabase
          .from("scheduled_tasks")
          .select("id,title,status")
          .eq("owner_id", input.ownerId)
          .ilike("title", scheduleName);

        const target =
          schedules?.length === 1
            ? schedules[0]
            : (schedules || []).find(
                (schedule) => schedule.title.trim().toLowerCase() === scheduleName.toLowerCase(),
              );

        if (!target) {
          throw new Error(`Schedule "${scheduleName}" could not be uniquely resolved.`);
        }

        const { error } = await supabase
          .from("scheduled_tasks")
          .update({
            status,
            updated_at: new Date().toISOString(),
          })
          .eq("id", target.id);

        if (error) throw new Error(error.message);

        results.push({
          type: action.type,
          status: "completed",
          summary: `Schedule "${target.title}" is now ${status}.`,
          data: { scheduled_task_id: target.id },
        });
        continue;
      }

      results.push({
        type: action.type,
        status: "skipped",
        summary: "Action type is not implemented.",
      });
    } catch (error) {
      results.push({
        type: action.type,
        status: "failed",
        summary: error instanceof Error ? error.message : "Action failed.",
      });
    }
  }

  return results;
}
