"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ProjectType } from "@/lib/domain/types";

const projectTypes = new Set<ProjectType>(["owned", "client", "lead_prospect"]);

function textValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function createProject(formData: FormData) {
  const name = textValue(formData, "name");
  const domain = textValue(formData, "domain")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const description = textValue(formData, "description");
  const rawType = textValue(formData, "projectType") as ProjectType;

  if (!name || !projectTypes.has(rawType)) {
    redirect("/new-project?error=Project%20name%20and%20type%20are%20required");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;

  if (claimsError || !ownerId) redirect("/login");

  const baseSlug = slugify(name) || "project";
  const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;

  const { error } = await supabase.from("projects").insert({
    owner_id: ownerId,
    name,
    slug,
    domain: domain || null,
    project_type: rawType,
    description: description || null,
  });

  if (error) redirect(`/new-project?error=${encodeURIComponent(error.message)}`);
  redirect("/projects");
}
