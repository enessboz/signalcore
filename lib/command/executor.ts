import { executeAgentTask } from "@/lib/agents/runtime";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
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
        ].includes(action.type) &&
        !projectId
      ) {
        throw new Error(
          `Project could not be resolved from "${action.project_ref || "empty reference"}".`,
        );
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

        const runId = await executeAgentTask({
          ownerId: input.ownerId,
          projectId: projectId!,
          selectedAgentKey: "reporting_output",
          userRequest: `Prepare a ${format} output. ${task}`,
        });

        const { data: completedRun } = await supabase
          .from("agent_runs")
          .select("output")
          .eq("id", runId)
          .maybeSingle();

        const output = (completedRun?.output || {}) as {
          summary?: string;
          importance?: string;
          confidence?: string;
          findings?: Array<{
            title?: string;
            why_it_matters?: string;
            recommended_action?: string;
          }>;
          next_actions?: string[];
        };

        const markdownParts = [
          output.summary ? "# Executive Summary\n\n" + output.summary : "",
          output.findings?.length
            ? "\n\n# Findings\n\n" +
              output.findings
                .map(
                  (finding, index) =>
                    "## " +
                    String(index + 1) +
                    ". " +
                    (finding.title || "Finding") +
                    "\n\n" +
                    (finding.why_it_matters || "") +
                    (finding.recommended_action
                      ? "\n\n**Recommended action:** " + finding.recommended_action
                      : ""),
                )
                .join("\n\n")
            : "",
          output.next_actions?.length
            ? "\n\n# Next Actions\n\n" +
              output.next_actions.map((item) => "- " + item).join("\n")
            : "",
        ].filter(Boolean);

        const { data: project } = await supabase
          .from("projects")
          .select("name")
          .eq("id", projectId!)
          .maybeSingle();

        const { data: generated, error: outputError } = await supabase
          .from("generated_outputs")
          .insert({
            project_id: projectId!,
            owner_id: input.ownerId,
            agent_run_id: runId,
            output_type: format,
            title:
              (project?.name || "Project") +
              " · " +
              format.charAt(0).toUpperCase() +
              format.slice(1),
            status: "draft",
            body_markdown: markdownParts.join("") || output.summary || "",
            data: output,
          })
          .select("id,title")
          .single();

        if (outputError || !generated) {
          throw new Error(outputError?.message || "Generated output could not be saved.");
        }

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "reporting_output",
          summary: `Reporting Agent created a ${format} draft: ${generated.title}.`,
          data: { run_id: runId, output_id: generated.id, format },
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
