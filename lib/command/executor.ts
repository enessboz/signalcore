import { executeAgentTask } from "@/lib/agents/runtime";
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
        ["delegate_agent", "create_ga4_funnel", "schedule_agent_task", "request_report"].includes(
          action.type,
        ) &&
        !projectId
      ) {
        throw new Error(
          `Project could not be resolved from "${action.project_ref || "empty reference"}".`,
        );
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

        results.push({
          type: action.type,
          status: "completed",
          projectId,
          targetAgentKey: "reporting_output",
          summary: `Reporting Agent started a ${format} output.`,
          data: { run_id: runId, format },
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
