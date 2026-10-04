"use server";

import { redirect } from "next/navigation";
import { detectWarehouseOpportunities } from "@/lib/rules/warehouse-opportunities";
import { createClient } from "@/lib/supabase/server";

export async function saveGscView(projectId: string, formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  const configRaw = String(formData.get("config") || "{}");

  if (!name) {
    redirect(`/projects/${projectId}/search-console?error=Saved%20view%20name%20is%20required`);
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch {
    redirect(`/projects/${projectId}/search-console?error=Invalid%20view%20configuration`);
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("saved_analytics_views").insert({
    project_id: projectId,
    owner_id: ownerId,
    data_source: "gsc",
    name,
    config,
  });

  if (error) {
    redirect(`/projects/${projectId}/search-console?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/projects/${projectId}/search-console?message=Search%20Console%20view%20saved`);
}

export async function runGscOpportunityScan(projectId: string) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .insert({
      project_id: projectId,
      owner_id: ownerId,
      job_type: "warehouse_opportunity_scan",
      trigger_type: "manual",
      status: "running",
      payload: {
        scan_gsc: true,
        scan_ga4: false,
        scan_rank: true,
        source: "search_console_workspace",
      },
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    redirect(
      "/projects/" +
        projectId +
        "/search-console?error=" +
        encodeURIComponent(
          jobError?.message || "Could not start warehouse opportunity scan",
        ),
    );
  }

  try {
    const result = await detectWarehouseOpportunities({
      ownerId,
      projectId,
      scanGsc: true,
      scanGa4: false,
      scanRank: true,
      client: supabase,
    });

    if (!result.gscReady && !result.gscQueryPageReady) {
      const coverage = result.coverage?.gsc || {};
      throw new Error(
        "GSC warehouse coverage is not ready yet. Current query coverage: " +
          String(coverage.current_days || 0) +
          " days; at least 14 days are required for current-period opportunities and 21+21 days for period comparisons.",
      );
    }

    await supabase
      .from("jobs")
      .update({
        status: "succeeded",
        result_summary: result,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    redirect(
      "/opportunities?project=" +
        projectId +
        "&message=" +
        encodeURIComponent(
          "Warehouse GSC scan completed: " +
            String(result.candidates) +
            " intelligence candidates",
        ),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Warehouse GSC opportunity scan failed.";

    await supabase
      .from("jobs")
      .update({
        status: "failed",
        result_summary: { error: message },
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    redirect(
      "/projects/" +
        projectId +
        "/search-console?error=" +
        encodeURIComponent(message),
    );
  }
}

