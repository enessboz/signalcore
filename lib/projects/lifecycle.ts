import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export async function convertLeadProspectProjectToClient(input: {
  ownerId: string;
  projectId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: project, error } = await supabase
    .from("projects")
    .select("id,name,domain,project_type,description,metadata")
    .eq("id", input.projectId)
    .eq("owner_id", input.ownerId)
    .single();

  if (error || !project) {
    throw new Error(error?.message || "Project not found.");
  }

  if (project.project_type === "client") {
    return { projectId: project.id as string, changed: false };
  }

  if (project.project_type !== "lead_prospect") {
    throw new Error("Only Lead Prospect projects can be converted to Client.");
  }

  const now = new Date().toISOString();
  const metadata = {
    ...((project.metadata || {}) as Record<string, unknown>),
    converted_from_project_type: "lead_prospect",
    converted_to_client_at: now,
  };

  const { error: updateError } = await supabase
    .from("projects")
    .update({
      project_type: "client",
      description:
        "Client workspace converted from Lead Prospect. Public audit and sales history are retained. Use client-supplied information and explicitly bound first-party sources such as GSC/GA4 when available; do not infer undisclosed internal roadmap, strategy or business data.",
      metadata,
      updated_at: now,
    })
    .eq("id", project.id)
    .eq("owner_id", input.ownerId);

  if (updateError) throw new Error(updateError.message);

  const { data: linkedLead } = await supabase
    .from("sales_leads")
    .select("id,stage")
    .eq("owner_id", input.ownerId)
    .eq("converted_project_id", project.id)
    .maybeSingle();

  if (linkedLead) {
    await supabase
      .from("sales_leads")
      .update({
        stage: "won",
        updated_at: now,
      })
      .eq("id", linkedLead.id)
      .eq("owner_id", input.ownerId);

    await supabase.from("sales_events").insert({
      lead_id: linkedLead.id,
      owner_id: input.ownerId,
      event_type: "converted_to_client",
      summary: "Lead Prospect project converted to Client workspace.",
      metadata: {
        project_id: project.id,
        converted_at: now,
      },
    });
  }

  await supabase.from("audit_events").insert({
    project_id: project.id,
    owner_id: input.ownerId,
    actor_type: "user",
    event_type: "project_converted_to_client",
    entity_type: "project",
    entity_id: project.id,
    metadata: {
      previous_type: "lead_prospect",
      new_type: "client",
      linked_sales_lead_id: linkedLead?.id || null,
    },
  });

  return { projectId: project.id as string, changed: true };
}
