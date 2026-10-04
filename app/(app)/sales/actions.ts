"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runSalesDiscoveryCampaign } from "@/lib/sales/discovery";
import { qualifySalesLead } from "@/lib/sales/qualification";
import { qualifyTopCampaignLeads } from "@/lib/sales/automation";
import {
  auditSalesLeadProspect,
  convertSalesLeadToProspect,
  createSalesDeckForLead,
} from "@/lib/sales/prospect";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function splitLines(value: string, max = 20) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, max);
}

async function owner() {
  const supabase = await createClient();
  const { data: claims, error } = await supabase.auth.getClaims();
  const ownerId = claims?.claims?.sub;
  if (error || !ownerId) redirect("/login");
  return { supabase, ownerId };
}

export async function createSalesCampaign(formData: FormData) {
  const name = text(formData, "name");
  const country = text(formData, "country");
  const industry = text(formData, "industry");
  const queries = splitLines(text(formData, "queries"), 20);
  const exclusions = splitLines(text(formData, "exclusions"), 50);
  const locationCode = Number(text(formData, "locationCode") || "2840");
  const languageCode = text(formData, "languageCode") || "en";
  const depth = Math.min(Math.max(Number(text(formData, "depth") || "20"), 10), 100);
  const minScore = Math.min(Math.max(Number(text(formData, "minScore") || "65"), 0), 100);
  const maxCandidates = Math.min(
    Math.max(Number(text(formData, "maxCandidates") || "100"), 1),
    1000,
  );
  const maxRunCost = Math.max(Number(text(formData, "maxRunCost") || "0.25"), 0);

  if (!name || !queries.length || !Number.isFinite(locationCode)) {
    redirect("/sales?error=Campaign%20name,%20queries%20and%20location%20code%20are%20required");
  }

  const { supabase, ownerId } = await owner();
  const { error } = await supabase.from("sales_campaigns").insert({
    owner_id: ownerId,
    name,
    country: country || null,
    industry: industry || null,
    location_code: locationCode,
    language_code: languageCode,
    queries,
    exclusions,
    depth,
    min_score: minScore,
    max_candidates: maxCandidates,
    max_run_cost_usd: maxRunCost,
    status: "draft",
  });

  if (error) redirect(`/sales?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/sales");
  redirect("/sales?message=Discovery%20campaign%20created");
}

export async function runSalesCampaign(campaignId: string) {
  const { ownerId } = await owner();

  try {
    const result = await runSalesDiscoveryCampaign({ ownerId, campaignId });
    revalidatePath("/sales");
    redirect(
      `/sales?message=${encodeURIComponent(
        `Discovery complete: ${result.uniqueCandidates} candidates, ${result.leadsCreated} new leads, $${result.actualCost.toFixed(4)} cost`,
      )}`,
    );
  } catch (error) {
    redirect(
      `/sales?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Discovery failed",
      )}`,
    );
  }
}

export async function qualifyLead(leadId: string) {
  const { ownerId } = await owner();

  try {
    const result = await qualifySalesLead({ ownerId, leadId });
    revalidatePath("/sales");
    redirect(
      `/sales?message=${encodeURIComponent(
        `Lead qualification: ${result.score}/100 · ${result.qualificationStatus}`,
      )}`,
    );
  } catch (error) {
    redirect(
      `/sales?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Qualification failed",
      )}`,
    );
  }
}

export async function qualifyCampaignTopLeads(campaignId: string) {
  const { supabase, ownerId } = await owner();

  try {
    const result = await qualifyTopCampaignLeads({
      ownerId,
      campaignId,
      limit: 10,
      client: supabase,
    });

    revalidatePath("/sales");
    redirect(
      "/sales?message=" +
        encodeURIComponent(
          "Qualified " +
            String(result.succeeded) +
            "/" +
            String(result.requested) +
            " top leads" +
            (result.failed ? " · " + String(result.failed) + " failed" : ""),
        ),
    );
  } catch (error) {
    redirect(
      "/sales?error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "Batch qualification failed",
        ),
    );
  }
}

export async function saveSalesCampaignAutomation(
  campaignId: string,
  formData: FormData,
) {
  const enabled = formData.get("autoEnabled") === "on";
  const scheduleKind = text(formData, "scheduleKind") || "weekly";
  const timeLocal = text(formData, "timeLocal") || "10:00";
  const timezone = text(formData, "timezone") || "Europe/Istanbul";
  const autoQualifyCount = Math.min(
    Math.max(Number(text(formData, "autoQualifyCount") || "5"), 0),
    10,
  );
  const daysOfWeek = text(formData, "daysOfWeek")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  const dayOfMonth = Math.min(
    Math.max(Number(text(formData, "dayOfMonth") || "1"), 1),
    31,
  );

  if (!["daily", "weekly", "monthly"].includes(scheduleKind)) {
    redirect("/sales?error=Invalid%20sales%20automation%20schedule");
  }
  if (!/^\d{2}:\d{2}$/.test(timeLocal)) {
    redirect("/sales?error=Automation%20time%20must%20use%20HH:MM");
  }
  if (scheduleKind === "weekly" && !daysOfWeek.length) {
    redirect("/sales?error=Weekly%20automation%20requires%20days%20of%20week");
  }

  const { supabase, ownerId } = await owner();
  const scheduleConfig = {
    time_local: timeLocal,
    days_of_week: scheduleKind === "weekly" ? daysOfWeek : [],
    day_of_month: scheduleKind === "monthly" ? dayOfMonth : null,
  };

  const { error } = await supabase
    .from("sales_campaigns")
    .update({
      auto_discovery_enabled: enabled,
      schedule_kind: scheduleKind,
      schedule_config: scheduleConfig,
      timezone,
      auto_qualify_count: autoQualifyCount,
      last_auto_status: enabled ? "idle" : "paused",
      last_auto_error: null,
      status: enabled ? "active" : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect("/sales?error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/sales");
  revalidatePath("/automations");
  redirect(
    "/sales?message=" +
      encodeURIComponent(
        enabled
          ? "Sales campaign automation enabled"
          : "Sales campaign automation disabled",
      ),
  );
}

export async function convertLead(leadId: string) {
  const { ownerId } = await owner();
  try {
    const result = await convertSalesLeadToProspect({ ownerId, leadId });
    revalidatePath("/sales");
    revalidatePath("/projects");
    redirect(
      `/sales?message=${encodeURIComponent(
        result.created ? "Lead converted to Lead Prospect" : "Lead Prospect already exists",
      )}`,
    );
  } catch (error) {
    redirect(
      `/sales?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Conversion failed",
      )}`,
    );
  }
}

export async function auditLead(leadId: string) {
  const { ownerId } = await owner();
  try {
    const result = await auditSalesLeadProspect({ ownerId, leadId, maxUrls: 50 });
    revalidatePath("/sales");
    revalidatePath(`/projects/${result.projectId}/technical`);
    redirect(
      `/sales?message=${encodeURIComponent(
        `Prospect audit completed: ${String(result.summary.pages_crawled || 0)} pages`,
      )}`,
    );
  } catch (error) {
    redirect(
      `/sales?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Prospect audit failed",
      )}`,
    );
  }
}

export async function createLeadDeck(leadId: string) {
  const { ownerId } = await owner();
  try {
    const result = await createSalesDeckForLead({ ownerId, leadId });
    revalidatePath("/sales");
    revalidatePath("/outputs");
    redirect(
      `/outputs/${result.outputId}`,
    );
  } catch (error) {
    redirect(
      `/sales?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Sales deck failed",
      )}`,
    );
  }
}

export async function setLeadStage(leadId: string, formData: FormData) {
  const stage = text(formData, "stage");
  const allowed = new Set([
    "discovered","qualified","audited","contact_found","outreach_ready",
    "contacted","replied","meeting","proposal","won","lost","rejected",
  ]);
  if (!allowed.has(stage)) redirect("/sales?error=Invalid%20lead%20stage");

  const { supabase, ownerId } = await owner();
  const { data: lead, error } = await supabase
    .from("sales_leads")
    .update({ stage, updated_at: new Date().toISOString() })
    .eq("id", leadId)
    .eq("owner_id", ownerId)
    .select("id,domain")
    .single();

  if (error || !lead) {
    redirect(`/sales?error=${encodeURIComponent(error?.message || "Lead not found")}`);
  }

  await supabase.from("sales_events").insert({
    lead_id: leadId,
    owner_id: ownerId,
    event_type: "stage_changed",
    summary: `Pipeline stage changed to ${stage}.`,
    metadata: { stage },
  });

  revalidatePath("/sales");
  redirect("/sales");
}
