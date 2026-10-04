import type { SupabaseClient } from "@supabase/supabase-js";
import { executeAgentTask } from "@/lib/agents/runtime";
import { createClient } from "@/lib/supabase/server";

export type OutputFormat = "summary" | "document" | "presentation" | "task" | "email";

export async function createReportingOutput(input: {
  ownerId: string;
  projectId: string;
  format: OutputFormat;
  instruction: string;
  triggerType?: "manual" | "scheduled" | "handoff" | "condition";
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const runId = await executeAgentTask({
    ownerId: input.ownerId,
    projectId: input.projectId,
    selectedAgentKey: "reporting_output",
    userRequest: `Prepare a ${input.format} output. ${input.instruction}`,
    triggerType: input.triggerType || "manual",
    client: supabase,
  });

  const [{ data: completedRun }, { data: project }, { data: profile }] = await Promise.all([
    supabase
      .from("agent_runs")
      .select("output")
      .eq("id", runId)
      .maybeSingle(),
    supabase
      .from("projects")
      .select("name")
      .eq("id", input.projectId)
      .maybeSingle(),
    supabase
      .from("output_profiles")
      .select("profile_key,rules")
      .eq("owner_id", input.ownerId)
      .eq("output_type", input.format)
      .eq("active", true)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

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

  const title =
    (project?.name || "Project") +
    " · " +
    input.format.charAt(0).toUpperCase() +
    input.format.slice(1);

  const { data: generated, error } = await supabase
    .from("generated_outputs")
    .insert({
      project_id: input.projectId,
      owner_id: input.ownerId,
      agent_run_id: runId,
      output_type: input.format,
      title,
      status: "draft",
      body_markdown: markdownParts.join("") || output.summary || "",
      data: {
        ...output,
        output_profile_rules: profile?.rules || null,
      },
      profile_key: profile?.profile_key || null,
    })
    .select("id,title")
    .single();

  if (error || !generated) {
    throw new Error(error?.message || "Generated output could not be saved.");
  }

  return {
    runId,
    outputId: generated.id as string,
    title: generated.title as string,
    format: input.format,
  };
}
