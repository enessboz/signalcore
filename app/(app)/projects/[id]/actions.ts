"use server";

import { redirect } from "next/navigation";
import { enqueueGoogleSync } from "@/lib/google/sync";
import { createClient } from "@/lib/supabase/server";

function textValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function chunkText(input: string, maxChars = 1500) {
  const paragraphs = input
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [input.slice(0, maxChars)];
}

export async function addBackgroundSource(projectId: string, formData: FormData) {
  const title = textValue(formData, "title");
  const content = textValue(formData, "content");

  if (!title || content.length < 20) {
    redirect(`/projects/${projectId}?error=Add%20a%20title%20and%20at%20least%2020%20characters%20of%20background`);
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) redirect("/login");

  const { data: source, error: sourceError } = await supabase
    .from("project_sources")
    .insert({
      project_id: projectId,
      owner_id: ownerId,
      source_type: "manual_background",
      title,
      content_text: content,
      metadata: { char_count: content.length },
    })
    .select("id")
    .single();

  if (sourceError || !source) {
    redirect(`/projects/${projectId}?error=${encodeURIComponent(sourceError?.message || "Could not save source")}`);
  }

  const chunks = chunkText(content);
  const rows = chunks.map((chunk, index) => ({
    source_id: source.id,
    project_id: projectId,
    owner_id: ownerId,
    chunk_index: index,
    content: chunk,
    metadata: { char_count: chunk.length },
  }));

  const { error: chunkError } = await supabase.from("background_chunks").insert(rows);

  if (chunkError) {
    await supabase.from("project_sources").delete().eq("id", source.id);
    redirect(`/projects/${projectId}?error=${encodeURIComponent(chunkError.message)}`);
  }

  redirect(`/projects/${projectId}?message=Background%20source%20added%20to%20Project%20Brain`);
}

export async function bindGoogleResource(
  projectId: string,
  bindingType: "gsc" | "ga4",
  formData: FormData,
) {
  const resourceId = textValue(formData, "resourceId");
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (claimsError || !ownerId) redirect("/login");

  if (!resourceId) {
    await supabase
      .from("project_bindings")
      .delete()
      .eq("project_id", projectId)
      .eq("binding_type", bindingType)
      .eq("binding_role", "primary");

    redirect(`/projects/${projectId}?message=${bindingType.toUpperCase()}%20binding%20removed`);
  }

  const expectedType = bindingType === "gsc" ? "gsc_property" : "ga4_property";

  const { data: resource, error: resourceError } = await supabase
    .from("connection_resources")
    .select("id,connection_id,resource_type,resource_id,display_name")
    .eq("id", resourceId)
    .eq("resource_type", expectedType)
    .eq("active", true)
    .single();

  if (resourceError || !resource) {
    redirect(`/projects/${projectId}?error=Selected%20Google%20resource%20is%20not%20available`);
  }

  const { error } = await supabase
    .from("project_bindings")
    .upsert(
      {
        project_id: projectId,
        owner_id: ownerId,
        connection_id: resource.connection_id,
        resource_id: resource.id,
        binding_type: bindingType,
        binding_role: "primary",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,binding_type,binding_role" },
    );

  if (error) {
    redirect(`/projects/${projectId}?error=${encodeURIComponent(error.message)}`);
  }

  redirect(
    `/projects/${projectId}?message=${bindingType.toUpperCase()}%20property%20connected%20to%20project`,
  );
}


function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export async function setGoogleAutoSync(
  projectId: string,
  bindingType: "gsc" | "ga4",
  enabled: boolean,
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("project_bindings")
    .update({
      auto_sync_enabled: enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .eq("binding_type", bindingType)
    .eq("binding_role", "primary");

  if (error) {
    redirect(`/projects/${projectId}?error=${encodeURIComponent(error.message)}`);
  }

  redirect(
    `/projects/${projectId}?message=${bindingType.toUpperCase()}%20auto%20sync%20${enabled ? "enabled" : "disabled"}`,
  );
}

export async function queueGoogleBackfill(
  projectId: string,
  bindingType: "gsc" | "ga4",
  formData: FormData,
) {
  const requestedDays = Number(String(formData.get("days") || "90"));
  const days = [30, 90, 180].includes(requestedDays) ? requestedDays : 90;

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: binding } = await supabase
    .from("project_bindings")
    .select("id")
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .eq("binding_type", bindingType)
    .eq("binding_role", "primary")
    .maybeSingle();

  if (!binding) {
    redirect(
      `/projects/${projectId}?error=${bindingType.toUpperCase()}%20property%20must%20be%20selected%20before%20backfill`,
    );
  }

  const lagDays = bindingType === "gsc" ? 3 : 1;
  const endDate = isoDaysAgo(lagDays);
  const startDate = isoDaysAgo(lagDays + days - 1);

  try {
    const jobId = await enqueueGoogleSync({
      ownerId,
      projectId,
      source: bindingType,
      startDate,
      endDate,
      mode: "backfill",
      priority: 60,
      client: supabase,
    });

    redirect(
      `/projects/${projectId}?message=${bindingType.toUpperCase()}%20${days}-day%20backfill%20queued%20(${jobId.slice(0, 8)})`,
    );
  } catch (error) {
    redirect(
      `/projects/${projectId}?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Backfill could not be queued",
      )}`,
    );
  }
}
