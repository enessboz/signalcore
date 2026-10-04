"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runSalesDiscoveryCampaign } from "@/lib/sales/discovery";
import { qualifySalesLead } from "@/lib/sales/qualification";
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

  const { data: rows, error } = await supabase
    .from("sales_campaign_leads")
    .select("lead_id,sales_leads(score,qualification_status)")
    .eq("campaign_id", campaignId)
    .eq("owner_id", ownerId)
    .order("discovered_at", { ascending: false })
    .limit(100);

  if (error) redirect(`/sales?error=${encodeURIComponent(error.message)}`);

  const pending = (rows || [])
    .filter((row) => {
      const lead = Array.isArray(row.sales_leads) ? row.sales_leads[0] : row.sales_leads;
      return lead?.qualification_status === "pending";
    })
    .sort((a, b) => {
      const aLead = Array.isArray(a.sales_leads) ? a.sales_leads[0] : a.sales_leads;
      const bLead = Array.isArray(b.sales_leads) ? b.sales_leads[0] : b.sales_leads;
      return Number(bLead?.score || 0) - Number(aLead?.score || 0);
    })
    .slice(0, 10);

  let succeeded = 0;
  const errors: string[] = [];
  for (const row of pending) {
    try {
      await qualifySalesLead({ ownerId, leadId: row.lead_id, client: supabase });
      succeeded += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Qualification failed");
    }
  }

  revalidatePath("/sales");
  redirect(
    `/sales?message=${encodeURIComponent(
      `Qualified ${succeeded}/${pending.length} top leads${errors.length ? ` · ${errors.length} failed` : ""}`,
    )}`,
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
