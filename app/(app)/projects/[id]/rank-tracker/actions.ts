"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  runRankTrackingBatch,
  seedTrackedKeywordsFromGsc,
} from "@/lib/seo/rank-tracking";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function splitKeywords(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 500);
}

async function auth() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");
  return { supabase, ownerId };
}

export async function saveRankTrackingSettings(
  projectId: string,
  formData: FormData,
) {
  const autoDiscover = formData.get("autoDiscover") === "on";
  const autoFindings = formData.get("autoFindings") === "on";
  const active = formData.get("active") === "on";
  const maxAutoKeywords = Math.min(
    Math.max(Number(text(formData, "maxAutoKeywords") || "100"), 0),
    1000,
  );
  const minImpressions = Math.max(
    Number(text(formData, "minImpressions") || "100"),
    0,
  );
  const positionMin = Math.max(
    Number(text(formData, "positionMin") || "1"),
    0,
  );
  const positionMax = Math.max(
    Number(text(formData, "positionMax") || "30"),
    positionMin,
  );
  const locationCode = Number(text(formData, "locationCode") || "2840");
  const languageCode = text(formData, "languageCode") || "en";
  const device = text(formData, "device") === "mobile" ? "mobile" : "desktop";
  const dailyHighPriorityLimit = Math.min(
    Math.max(Number(text(formData, "dailyHighPriorityLimit") || "20"), 0),
    200,
  );

  if (!Number.isFinite(locationCode)) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=Invalid%20location%20code",
    );
  }

  const { supabase, ownerId } = await auth();

  const { error } = await supabase.from("rank_tracking_settings").upsert(
    {
      project_id: projectId,
      owner_id: ownerId,
      active,
      auto_discover_enabled: autoDiscover,
      auto_findings_enabled: autoFindings,
      max_auto_keywords: maxAutoKeywords,
      min_impressions_28d: minImpressions,
      position_min: positionMin,
      position_max: positionMax,
      default_location_code: locationCode,
      default_language_code: languageCode,
      default_device: device,
      daily_high_priority_limit: dailyHighPriorityLimit,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=" +
        encodeURIComponent(error.message),
    );
  }

  revalidatePath("/projects/" + projectId + "/rank-tracker");
  revalidatePath("/automations");
  redirect(
    "/projects/" +
      projectId +
      "/rank-tracker?message=" +
      encodeURIComponent("Rank tracking settings saved"),
  );
}

export async function addTrackedKeywords(
  projectId: string,
  formData: FormData,
) {
  const keywords = splitKeywords(text(formData, "keywords"));
  const targetUrl = text(formData, "targetUrl") || null;
  const priority = ["high", "normal", "low"].includes(text(formData, "priority"))
    ? text(formData, "priority")
    : "normal";
  const cadence = ["daily", "weekly", "monthly"].includes(
    text(formData, "cadence"),
  )
    ? text(formData, "cadence")
    : "weekly";
  const depth = Math.min(
    Math.max(Number(text(formData, "depth") || "30"), 10),
    100,
  );
  const locationCode = Number(text(formData, "locationCode") || "2840");
  const languageCode = text(formData, "languageCode") || "en";
  const device = text(formData, "device") === "mobile" ? "mobile" : "desktop";

  if (!keywords.length) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=At%20least%20one%20keyword%20is%20required",
    );
  }

  const { supabase, ownerId } = await auth();

  const rows = keywords.map((keyword) => ({
    project_id: projectId,
    owner_id: ownerId,
    keyword,
    target_url: targetUrl,
    source: "manual",
    priority,
    cadence,
    depth,
    location_code: locationCode,
    language_code: languageCode,
    device,
    active: true,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from("tracked_keywords").upsert(rows, {
    onConflict: "project_id,keyword,location_code,language_code,device",
  });

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=" +
        encodeURIComponent(error.message),
    );
  }

  await supabase.from("rank_tracking_settings").upsert(
    {
      project_id: projectId,
      owner_id: ownerId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  revalidatePath("/projects/" + projectId + "/rank-tracker");
  redirect(
    "/projects/" +
      projectId +
      "/rank-tracker?message=" +
      encodeURIComponent(String(keywords.length) + " keyword(s) saved"),
  );
}

export async function seedFromGsc(projectId: string) {
  const { supabase, ownerId } = await auth();

  try {
    const result = await seedTrackedKeywordsFromGsc({
      ownerId,
      projectId,
      client: supabase,
    });
    revalidatePath("/projects/" + projectId + "/rank-tracker");
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?message=" +
        encodeURIComponent(
          "GSC seed complete: " +
            String(result.inserted) +
            " new keyword(s) from " +
            String(result.candidates) +
            " candidates",
        ),
    );
  } catch (error) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "GSC seed failed",
        ),
    );
  }
}

export async function runRankCheck(
  projectId: string,
  keywordId?: string,
) {
  const { supabase, ownerId } = await auth();

  try {
    const result = await runRankTrackingBatch({
      ownerId,
      projectId,
      keywordIds: keywordId ? [keywordId] : undefined,
      triggerType: "manual",
      limit: keywordId ? 1 : 10,
      onlyDue: false,
      client: supabase,
    });

    revalidatePath("/projects/" + projectId + "/rank-tracker");
    revalidatePath("/opportunities");
    revalidatePath("/costs");

    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?message=" +
        encodeURIComponent(
          "Rank check complete: " +
            String(result.succeeded) +
            " succeeded, " +
            String(result.failed) +
            " failed · $" +
            Number(result.actualCost || 0).toFixed(4),
        ),
    );
  } catch (error) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "Rank check failed",
        ),
    );
  }
}

export async function updateTrackedKeyword(
  projectId: string,
  keywordId: string,
  formData: FormData,
) {
  const priority = ["high", "normal", "low"].includes(text(formData, "priority"))
    ? text(formData, "priority")
    : "normal";
  const cadence = ["daily", "weekly", "monthly"].includes(
    text(formData, "cadence"),
  )
    ? text(formData, "cadence")
    : "weekly";
  const depth = Math.min(
    Math.max(Number(text(formData, "depth") || "30"), 10),
    100,
  );
  const active = formData.get("active") === "on";
  const targetUrl = text(formData, "targetUrl") || null;

  const { supabase, ownerId } = await auth();

  const { error } = await supabase
    .from("tracked_keywords")
    .update({
      priority,
      cadence,
      depth,
      active,
      target_url: targetUrl,
      last_status: active ? "idle" : "paused",
      updated_at: new Date().toISOString(),
    })
    .eq("id", keywordId)
    .eq("project_id", projectId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=" +
        encodeURIComponent(error.message),
    );
  }

  revalidatePath("/projects/" + projectId + "/rank-tracker");
  redirect(
    "/projects/" +
      projectId +
      "/rank-tracker?message=Tracked%20keyword%20updated",
  );
}

export async function deleteTrackedKeyword(
  projectId: string,
  keywordId: string,
) {
  const { supabase, ownerId } = await auth();

  const { error } = await supabase
    .from("tracked_keywords")
    .delete()
    .eq("id", keywordId)
    .eq("project_id", projectId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/rank-tracker?error=" +
        encodeURIComponent(error.message),
    );
  }

  revalidatePath("/projects/" + projectId + "/rank-tracker");
  redirect(
    "/projects/" +
      projectId +
      "/rank-tracker?message=Tracked%20keyword%20removed",
  );
}
