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

  const { data: projectProfile } = await supabase
    .from("project_output_profiles")
    .select("profile_id, output_profiles(profile_key,rules,strict_mode,name)")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .eq("output_type", input.format)
    .maybeSingle();

  const nestedProfile = Array.isArray(projectProfile?.output_profiles)
    ? projectProfile?.output_profiles[0]
    : projectProfile?.output_profiles;

  let profile:
    | {
        profile_key: string;
        rules: Record<string, unknown>;
        strict_mode: boolean;
        name: string;
      }
    | null = nestedProfile
      ? {
          profile_key: nestedProfile.profile_key,
          rules: (nestedProfile.rules || {}) as Record<string, unknown>,
          strict_mode: Boolean(nestedProfile.strict_mode),
          name: nestedProfile.name,
        }
      : null;

  if (!profile) {
    const { data: defaultProfile } = await supabase
      .from("output_profiles")
      .select("profile_key,rules,strict_mode,name")
      .eq("owner_id", input.ownerId)
      .eq("output_type", input.format)
      .eq("active", true)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (defaultProfile) {
      profile = {
        profile_key: defaultProfile.profile_key,
        rules: (defaultProfile.rules || {}) as Record<string, unknown>,
        strict_mode: Boolean(defaultProfile.strict_mode),
        name: defaultProfile.name,
      };
    }
  }

  const profileInstruction = profile
    ? `\n\nOUTPUT PROFILE: ${profile.name}\nSTRICT MODE: ${profile.strict_mode ? "ON" : "OFF"}\nRULES:\n${JSON.stringify(profile.rules, null, 2)}\nFollow these output rules. Do not invent a format, layout, claim style, or section that conflicts with a strict profile.`
    : "";

  const runId = await executeAgentTask({
    ownerId: input.ownerId,
    projectId: input.projectId,
    selectedAgentKey: "reporting_output",
    userRequest: `Prepare a ${input.format} output. ${input.instruction}${profileInstruction}`,
    triggerType: input.triggerType || "manual",
    client: supabase,
  });

  const [{ data: completedRun }, { data: project }] = await Promise.all([
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
  ]);

  const output = (completedRun?.output || {}) as {
    summary?: string;
    importance?: string;
    confidence?: string;
    findings?: Array<{
      title?: string;
      finding_type?: "issue" | "opportunity" | "strategy_discovery" | "observation";
      why_it_matters?: string;
      recommended_action?: string;
      evidence_refs?: string[];
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


  const profileRules = profile?.rules || {};
  const allowedSlideTypes = Array.isArray(profileRules.allowed_slide_types)
    ? profileRules.allowed_slide_types.map(String)
    : [
        "title",
        "executive_summary",
        "opportunity",
        "technical_finding",
        "roadmap",
        "next_steps",
      ];

  function allowed(type: string, fallback: string) {
    if (!profile?.strict_mode) return type;
    if (allowedSlideTypes.includes(type)) return type;
    if (allowedSlideTypes.includes(fallback)) return fallback;
    return allowedSlideTypes[0] || fallback;
  }

  const presentationPlan =
    input.format === "presentation"
      ? [
          {
            slide_type: allowed("title", "executive_summary"),
            title: project?.name || "Project",
            key_message: output.summary || "Evidence-based project review",
            bullets: [] as string[],
            evidence_refs: [] as string[],
          },
          {
            slide_type: allowed("executive_summary", "opportunity"),
            title: "Executive Summary",
            key_message: output.summary || "Current evidence and priorities",
            bullets: (output.next_actions || []).slice(0, 3),
            evidence_refs: [] as string[],
          },
          ...(output.findings || []).map((finding) => ({
            slide_type:
              finding.finding_type === "issue"
                ? allowed("technical_finding", "opportunity")
                : allowed("opportunity", "executive_summary"),
            title: finding.title || "Finding",
            key_message: finding.why_it_matters || "",
            bullets: finding.recommended_action ? [finding.recommended_action] : [],
            evidence_refs: finding.evidence_refs || [],
          })),
          {
            slide_type: allowed("next_steps", "roadmap"),
            title: "Next Steps",
            key_message: "Recommended actions based on the evidence reviewed.",
            bullets: output.next_actions || [],
            evidence_refs: [] as string[],
          },
        ].filter((slide, index, all) => {
          if (!slide.title) return false;
          if (index === all.length - 1 && slide.bullets.length === 0) return false;
          return true;
        })
      : null;

  if (
    profile?.strict_mode &&
    presentationPlan &&
    presentationPlan.some((slide) => !allowedSlideTypes.includes(slide.slide_type))
  ) {
    throw new Error("Presentation output violated the strict allowed slide-type profile.");
  }

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
        deliverable_contract:
          input.format === "presentation"
            ? {
                type: "presentation_slide_plan",
                slides: presentationPlan,
              }
            : {
                type: input.format,
                sections: [
                  output.summary
                    ? { section_type: "summary", title: "Executive Summary", body: output.summary }
                    : null,
                  ...(output.findings || []).map((finding) => ({
                    section_type: finding.finding_type || "finding",
                    title: finding.title || "Finding",
                    body: finding.why_it_matters || "",
                    recommended_action: finding.recommended_action || null,
                    evidence_refs: finding.evidence_refs || [],
                  })),
                  output.next_actions?.length
                    ? { section_type: "next_actions", title: "Next Actions", items: output.next_actions }
                    : null,
                ].filter(Boolean),
              },
        output_profile_rules: profile?.rules || null,
        output_profile_strict: profile?.strict_mode || false,
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
