import { executeAgentTask } from "@/lib/agents/runtime";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
import { runSerpResearch } from "@/lib/seo/run-serp-research";
import { enqueueGoogleSync } from "@/lib/google/sync";
import { createReportingOutput } from "@/lib/outputs/reporting";
import type { ChiefPlan } from "@/lib/command/chief";
import { createClient } from "@/lib/supabase/server";

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
        ].includes(action.type) &&
        !projectId
      ) {
        throw new Error(
          `Project could not be resolved from "${action.project_ref || "empty reference"}".`,
        );
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
        if (!source || !days || ![30, 90, 180].includes(days)) {
          throw new Error("Backfill requires GSC/GA4 source and 30, 90 or 180 days.");
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
          data: { scheduled_task_id: scheduled.id, schedule: scheduleConfig },
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
