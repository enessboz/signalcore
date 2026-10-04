"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { evaluateInterventionCheck } from "@/lib/interventions/evaluate";

function textValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function lines(value: string) {
  return [...new Set(
    value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

function addDays(isoDate: string, days: number) {
  const date = new Date(isoDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeTargetUrl(value: string, domain: string) {
  try {
    const url = value.startsWith("/")
      ? new URL("https://" + domain + value)
      : value.includes("://")
        ? new URL(value)
        : new URL("https://" + value);
    return {
      url: url.toString().replace(/\/$/, ""),
      path: url.pathname || "/",
    };
  } catch {
    throw new Error("Invalid target URL: " + value);
  }
}

export async function createSeoIntervention(
  projectId: string,
  formData: FormData,
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: project } = await supabase
    .from("projects")
    .select("id,domain")
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .single();

  if (!project) {
    redirect("/projects?error=Project%20not%20available");
  }

  const title = textValue(formData, "title");
  const interventionType = textValue(formData, "interventionType") || "content";
  const implementedAt = textValue(formData, "implementedAt");
  const hypothesis = textValue(formData, "hypothesis");
  const notes = textValue(formData, "notes");
  const scopeMode = textValue(formData, "scopeMode") === "project"
    ? "project"
    : "targeted";
  const urlInputs = lines(textValue(formData, "urls"));
  const queryInputs = lines(textValue(formData, "queries"));

  if (!title || !implementedAt) {
    redirect(
      "/projects/" +
        projectId +
        "/interventions?error=" +
        encodeURIComponent("Title and implementation date are required."),
    );
  }

  if (scopeMode === "targeted" && !urlInputs.length && !queryInputs.length) {
    redirect(
      "/projects/" +
        projectId +
        "/interventions?error=" +
        encodeURIComponent(
          "A targeted intervention needs at least one URL or query.",
        ),
    );
  }

  try {
    const { data: intervention, error } = await supabase
      .from("seo_interventions")
      .insert({
        project_id: projectId,
        owner_id: ownerId,
        title,
        intervention_type: interventionType,
        implemented_at: implementedAt,
        hypothesis: hypothesis || null,
        notes: notes || null,
        scope_mode: scopeMode,
        status: "monitoring",
        gsc_lag_days: 3,
        ga4_lag_days: 1,
      })
      .select("id")
      .single();

    if (error || !intervention) {
      throw new Error(error?.message || "Intervention could not be created.");
    }

    if (urlInputs.length) {
      const urlRows = urlInputs.map((value) => {
        const normalized = normalizeTargetUrl(value, project.domain || "");
        return {
          intervention_id: intervention.id,
          project_id: projectId,
          owner_id: ownerId,
          url: normalized.url,
          url_path: normalized.path,
        };
      });
      const { error: urlError } = await supabase
        .from("seo_intervention_urls")
        .insert(urlRows);
      if (urlError) throw new Error(urlError.message);
    }

    if (queryInputs.length) {
      const { error: queryError } = await supabase
        .from("seo_intervention_queries")
        .insert(
          queryInputs.map((query) => ({
            intervention_id: intervention.id,
            project_id: projectId,
            owner_id: ownerId,
            query,
          })),
        );
      if (queryError) throw new Error(queryError.message);
    }

    const checkpoints = [7, 14, 28];
    const { error: checkpointError } = await supabase
      .from("seo_intervention_checks")
      .insert(
        checkpoints.map((checkpointDays) => ({
          intervention_id: intervention.id,
          project_id: projectId,
          owner_id: ownerId,
          checkpoint_days: checkpointDays,
          due_date: addDays(implementedAt, checkpointDays + 3),
          status: "pending",
        })),
      );

    if (checkpointError) throw new Error(checkpointError.message);

    redirect(
      "/projects/" +
        projectId +
        "/interventions?message=" +
        encodeURIComponent(
          "Intervention saved. D+7, D+14 and D+28 monitoring checkpoints were created.",
        ),
    );
  } catch (error) {
    redirect(
      "/projects/" +
        projectId +
        "/interventions?error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "Intervention could not be saved.",
        ),
    );
  }
}

export async function evaluateSeoInterventionCheck(
  projectId: string,
  checkId: string,
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: check } = await supabase
    .from("seo_intervention_checks")
    .select("id,owner_id,project_id")
    .eq("id", checkId)
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .single();

  if (!check) {
    redirect(
      "/projects/" +
        projectId +
        "/interventions?error=" +
        encodeURIComponent("Checkpoint not available."),
    );
  }

  try {
    const result = await evaluateInterventionCheck({
      checkId,
      client: supabase,
    });

    redirect(
      "/projects/" +
        projectId +
        "/interventions?message=" +
        encodeURIComponent(
          result.status === "evaluated"
            ? "Checkpoint evaluated: " + String(result.resultClass || "observation")
            : result.status === "pending"
              ? "Checkpoint is due but warehouse coverage is not sufficient yet."
              : "Checkpoint updated.",
        ),
    );
  } catch (error) {
    redirect(
      "/projects/" +
        projectId +
        "/interventions?error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "Checkpoint evaluation failed.",
        ),
    );
  }
}

export async function cancelSeoIntervention(
  projectId: string,
  interventionId: string,
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("seo_interventions")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", interventionId)
    .eq("project_id", projectId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/interventions?error=" +
        encodeURIComponent(error.message),
    );
  }

  await supabase
    .from("seo_intervention_checks")
    .update({
      status: "skipped",
      summary: "Intervention monitoring was cancelled.",
      evaluated_at: now,
      updated_at: now,
    })
    .eq("intervention_id", interventionId)
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .eq("status", "pending");

  redirect(
    "/projects/" +
      projectId +
      "/interventions?message=" +
      encodeURIComponent("Intervention monitoring cancelled."),
  );
}
