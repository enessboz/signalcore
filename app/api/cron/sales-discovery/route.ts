import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { isScheduleDue, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import { runSalesDiscoveryCampaign } from "@/lib/sales/discovery";
import { qualifyTopCampaignLeads } from "@/lib/sales/automation";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (!expected || auth !== "Bearer " + expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.SUPABASE_SECRET_KEY) {
    return NextResponse.json(
      { error: "SUPABASE_SECRET_KEY is not configured." },
      { status: 503 },
    );
  }

  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    return NextResponse.json(
      { error: "DataForSEO credentials are not configured." },
      { status: 503 },
    );
  }

  const supabase = createAdminClient();
  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:sales-discovery",
    ttlSeconds: 360,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another sales discovery invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const now = new Date();

  const { data: campaigns, error } = await supabase
    .from("sales_campaigns")
    .select("id,owner_id,name,status,auto_discovery_enabled,schedule_kind,schedule_config,timezone,auto_qualify_count,last_auto_run_at,last_auto_status,last_auto_error,auto_failure_count")
    .eq("auto_discovery_enabled", true)
    .in("status", ["draft", "active"])
    .order("updated_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const due = (campaigns || []).filter((campaign) => {
    if (!campaign.schedule_kind) return false;
    return isScheduleDue({
      scheduleKind: campaign.schedule_kind as ScheduleKind,
      scheduleConfig: (campaign.schedule_config || {}) as ScheduleConfig,
      timezone: campaign.timezone || "Europe/Istanbul",
      lastRunAt: campaign.last_auto_run_at,
      now,
    });
  }).slice(0, 3);

  const results: Array<Record<string, unknown>> = [];

  for (const campaign of due) {
    await supabase
      .from("sales_campaigns")
      .update({
        last_auto_status: "running",
        last_auto_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .eq("owner_id", campaign.owner_id);

    try {
      const discovery = await runSalesDiscoveryCampaign({
        ownerId: campaign.owner_id,
        campaignId: campaign.id,
        client: supabase,
      });

      const qualification = await qualifyTopCampaignLeads({
        ownerId: campaign.owner_id,
        campaignId: campaign.id,
        limit: campaign.auto_qualify_count || 0,
        client: supabase,
      });

      await supabase
        .from("sales_campaigns")
        .update({
          status: "active",
          last_auto_run_at: new Date().toISOString(),
          last_auto_status: discovery.status === "partial" ? "partial" : "succeeded",
          last_auto_error: null,
          auto_failure_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id)
        .eq("owner_id", campaign.owner_id);

      results.push({
        campaign_id: campaign.id,
        campaign: campaign.name,
        status: discovery.status,
        discovery,
        qualification,
      });
    } catch (runError) {
      const message =
        runError instanceof Error ? runError.message : "Sales campaign execution failed.";

      await supabase
        .from("sales_campaigns")
        .update({
          last_auto_run_at: new Date().toISOString(),
          last_auto_status: "failed",
          last_auto_error: message,
          auto_failure_count: Number(campaign.auto_failure_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id)
        .eq("owner_id", campaign.owner_id);

      results.push({
        campaign_id: campaign.id,
        campaign: campaign.name,
        status: "failed",
        error: message,
      });
    }
  }

  return NextResponse.json({
    checked: campaigns?.length || 0,
    due: due.length,
    processed: results.length,
    results,
    time: new Date().toISOString(),
  });
}

// Vercel Cron invokes production cron routes with GET.
export async function GET(request: NextRequest) {
  return POST(request);
}
