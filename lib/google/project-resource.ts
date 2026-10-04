import { createClient } from "@/lib/supabase/server";

export type GoogleBindingType = "gsc" | "ga4";

export async function getProjectGoogleResource(
  projectId: string,
  bindingType: GoogleBindingType,
) {
  const supabase = await createClient();

  const { data: binding, error } = await supabase
    .from("project_bindings")
    .select("resource_id,connection_id")
    .eq("project_id", projectId)
    .eq("binding_type", bindingType)
    .eq("binding_role", "primary")
    .maybeSingle();

  if (error || !binding) {
    throw new Error(
      bindingType === "gsc"
        ? "No Search Console property is selected for this project."
        : "No GA4 property is selected for this project.",
    );
  }

  const expectedResourceType =
    bindingType === "gsc" ? "gsc_property" : "ga4_property";

  const { data: resource, error: resourceError } = await supabase
    .from("connection_resources")
    .select("id,resource_type,resource_id,display_name,permission_level,parent_id,metadata")
    .eq("id", binding.resource_id)
    .eq("connection_id", binding.connection_id)
    .eq("resource_type", expectedResourceType)
    .eq("active", true)
    .maybeSingle();

  if (resourceError || !resource) {
    throw new Error("The selected Google resource is no longer available.");
  }

  return resource;
}
