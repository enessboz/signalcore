"use server";

import { redirect } from "next/navigation";
import { getProjectGoogleResource } from "@/lib/google/project-resource";
import { detectGscOpportunities } from "@/lib/rules/gsc-opportunities";
import { createClient } from "@/lib/supabase/server";

function dateDaysAgo(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

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

  let resource: Awaited<ReturnType<typeof getProjectGoogleResource>>;
  try {
    resource = await getProjectGoogleResource(projectId, "gsc");
  } catch (error) {
    const message = error instanceof Error ? error.message : "GSC property is not available.";
    redirect(`/projects/${projectId}/search-console?error=${encodeURIComponent(message)}`);
  }

  const currentEnd = dateDaysAgo(3);
  const currentStart = dateDaysAgo(30);
  const previousEnd = dateDaysAgo(31);
  const previousStart = dateDaysAgo(58);

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .insert({
      project_id: projectId,
      owner_id: ownerId,
      job_type: "gsc_opportunity_scan",
      trigger_type: "manual",
      status: "running",
      payload: {
        currentStart,
        currentEnd,
        previousStart,
        previousEnd,
        siteUrl: resource.resource_id,
      },
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    redirect(
      `/projects/${projectId}/search-console?error=${encodeURIComponent(jobError?.message || "Could not start opportunity scan")}`,
    );
  }

  try {
    const candidates = await detectGscOpportunities({
      siteUrl: resource.resource_id,
      currentStart,
      currentEnd,
      previousStart,
      previousEnd,
    });

    const now = new Date().toISOString();
    if (candidates.length) {
      const { error: findingError } = await supabase.from("findings").upsert(
        candidates.map((candidate) => ({
          project_id: projectId,
          owner_id: ownerId,
          finding_type: "opportunity",
          title: candidate.title,
          summary: candidate.summary,
          why_it_matters: candidate.whyItMatters,
          importance: candidate.importance,
          confidence: "high",
          status: "open",
          fingerprint: candidate.fingerprint,
          affected_scope: candidate.affectedScope,
          recommended_action: candidate.recommendedAction,
          metadata: {
            source: "gsc",
            detector: "rule_engine_v1",
            current_period: { start: currentStart, end: currentEnd },
            previous_period: { start: previousStart, end: previousEnd },
            ...candidate.metadata,
          },
          last_seen_at: now,
          updated_at: now,
        })),
        { onConflict: "project_id,fingerprint" },
      );

      if (findingError) throw findingError;
    }

    await supabase
      .from("jobs")
      .update({
        status: "succeeded",
        result_summary: { candidates: candidates.length },
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    redirect(
      `/opportunities?project=${projectId}&message=${encodeURIComponent(`GSC scan completed: ${candidates.length} opportunity candidates`)}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "GSC opportunity scan failed.";

    await supabase
      .from("jobs")
      .update({
        status: "failed",
        result_summary: { error: message },
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    redirect(`/projects/${projectId}/search-console?error=${encodeURIComponent(message)}`);
  }
}
