"use server";

import { redirect } from "next/navigation";
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
