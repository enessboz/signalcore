"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
import { startQueuedCrawl } from "@/lib/crawl/distributed";
import { createClient } from "@/lib/supabase/server";

export async function runTechnicalCrawl(projectId: string, formData: FormData) {
  const raw = Number(String(formData.get("maxUrls") || "100"));
  const allowed = [25, 50, 100, 200, 500, 1000, 5000, 10000];
  const maxUrls = allowed.includes(raw) ? raw : 100;
  const jsRenderModeRaw = String(formData.get("jsRenderMode") || "off");
  const jsRenderMode =
    jsRenderModeRaw === "auto" || jsRenderModeRaw === "always"
      ? jsRenderModeRaw
      : "off";
  const pagespeedEnabled = formData.get("pagespeedEnabled") === "on";

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  try {
    if (maxUrls > 500) {
      const result = await startQueuedCrawl({
        client: supabase,
        ownerId,
        projectId,
        maxUrls,
        crawlType: "http",
        batchSize: 50,
        minDelayMs: 250,
        respectRobots: true,
        jsRenderMode,
        pagespeedEnabled,
        pagespeedSampleSize: pagespeedEnabled ? 20 : 0,
      });

      redirect(
        `/projects/${projectId}/technical?run=${result.runId}&message=${encodeURIComponent(
          `Distributed crawl queued: ${maxUrls.toLocaleString("en-US")} URL ceiling`,
        )}`,
      );
    }

    const result = await runProjectCrawl({
      ownerId,
      projectId,
      maxUrls,
      crawlType: "http",
      jsRenderMode,
    });

    redirect(
      `/projects/${projectId}/technical?run=${result.runId}&message=${encodeURIComponent(
        `Crawl completed: ${String(result.summary.pages_crawled || 0)} pages`,
      )}`,
    );
  } catch (error) {
    redirect(
      `/projects/${projectId}/technical?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Technical crawl failed",
      )}`,
    );
  }
}


function textValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function saveTechnicalCrawlSchedule(
  projectId: string,
  formData: FormData,
) {
  const name = textValue(formData, "name") || "Technical Crawl";
  const crawlType = textValue(formData, "crawlType") === "delta" ? "delta" : "http";
  const rawMaxUrls = Number(textValue(formData, "maxUrls") || "100");
  const allowedMaxUrls = [25, 50, 100, 200, 500, 1000, 5000, 10000, 25000, 50000];
  const maxUrls = allowedMaxUrls.includes(rawMaxUrls)
    ? rawMaxUrls
    : 100;
  const batchSize = Math.min(
    Math.max(Number(textValue(formData, "batchSize") || "50"), 5),
    100,
  );
  const minDelayMs = Math.min(
    Math.max(Number(textValue(formData, "minDelayMs") || "250"), 0),
    10000,
  );
  const jsRenderModeRaw = textValue(formData, "jsRenderMode") || "off";
  const jsRenderMode =
    jsRenderModeRaw === "auto" || jsRenderModeRaw === "always"
      ? jsRenderModeRaw
      : "off";
  const pagespeedEnabled = formData.get("pagespeedEnabled") === "on";
  const pagespeedSampleSize = Math.min(
    Math.max(Number(textValue(formData, "pagespeedSampleSize") || "20"), 0),
    100,
  );
  const scheduleKind = textValue(formData, "scheduleKind") || "weekly";
  const timeLocal = textValue(formData, "timeLocal") || "10:00";
  const timezone = textValue(formData, "timezone") || "Europe/Istanbul";
  const daysOfWeek = textValue(formData, "daysOfWeek")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  const dayOfMonth = Math.min(
    Math.max(Number(textValue(formData, "dayOfMonth") || "1"), 1),
    31,
  );

  if (!["daily", "weekly", "monthly"].includes(scheduleKind)) {
    redirect("/projects/" + projectId + "/technical?error=Invalid%20schedule%20kind");
  }
  if (!/^\d{2}:\d{2}$/.test(timeLocal)) {
    redirect("/projects/" + projectId + "/technical?error=Time%20must%20use%20HH:MM");
  }
  if (scheduleKind === "weekly" && !daysOfWeek.length) {
    redirect("/projects/" + projectId + "/technical?error=Weekly%20schedule%20requires%20days");
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const scheduleConfig = {
    time_local: timeLocal,
    days_of_week: scheduleKind === "weekly" ? daysOfWeek : [],
    day_of_month: scheduleKind === "monthly" ? dayOfMonth : null,
  };

  const { error } = await supabase
    .from("technical_crawl_schedules")
    .upsert(
      {
        owner_id: ownerId,
        project_id: projectId,
        name,
        crawl_type: crawlType,
        max_urls: maxUrls,
        schedule_kind: scheduleKind,
        schedule_config: scheduleConfig,
        timezone,
        batch_size: batchSize,
        min_delay_ms: minDelayMs,
        respect_robots: true,
        js_render_mode: jsRenderMode,
        pagespeed_enabled: pagespeedEnabled,
        pagespeed_sample_size: pagespeedSampleSize,
        status: "active",
        last_status: "idle",
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,name" },
    );

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/technical?error=" +
        encodeURIComponent(error.message),
    );
  }

  revalidatePath("/projects/" + projectId + "/technical");
  revalidatePath("/automations");
  redirect(
    "/projects/" +
      projectId +
      "/technical?message=" +
      encodeURIComponent("Technical crawl schedule saved"),
  );
}

export async function setTechnicalCrawlScheduleStatus(
  projectId: string,
  scheduleId: string,
  status: "active" | "paused" | "cancelled",
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("technical_crawl_schedules")
    .update({
      status,
      last_status: status === "paused" ? "paused" : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", scheduleId)
    .eq("project_id", projectId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(
      "/projects/" +
        projectId +
        "/technical?error=" +
        encodeURIComponent(error.message),
    );
  }

  revalidatePath("/projects/" + projectId + "/technical");
  revalidatePath("/automations");
  redirect(
    "/projects/" +
      projectId +
      "/technical?message=" +
      encodeURIComponent("Technical crawl schedule " + status),
  );
}
