import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acquireRuntimeLease } from "@/lib/runtime/lease";
import { recoverStaleJobs } from "@/lib/runtime/recovery";
import { detectWarehouseOpportunities } from "@/lib/rules/warehouse-opportunities";

export const runtime = "nodejs";
export const maxDuration = 300;

function due(cadence: "daily" | "weekly", lastRunAt: string | null) {
  if (!lastRunAt) return true;
  const age = Date.now() - new Date(lastRunAt).getTime();
  return age >= (cadence === "weekly" ? 7 : 1) * 24 * 3600_000;
}

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

  const supabase = createAdminClient();
  const lease = await acquireRuntimeLease({
    client: supabase,
    key: "cron:opportunity-engine",
    ttlSeconds: 360,
  });

  if (!lease.acquired) {
    return NextResponse.json({
      status: "skipped",
      reason: "Another Opportunity Engine invocation still holds the runtime lease.",
      time: new Date().toISOString(),
    });
  }

  const recoveredStaleJobs = await recoverStaleJobs(supabase);

  const { data: settings, error } = await supabase
    .from("opportunity_scan_settings")
    .select("project_id,owner_id,enabled,scan_gsc,scan_ga4,scan_rank,cadence,last_run_at,last_data_date,last_status,last_error,consecutive_failures")
    .eq("enabled", true)
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const targets = (settings || [])
    .filter((item) => due(item.cadence as "daily" | "weekly", item.last_run_at))
    .slice(0, 10);

  const results: Array<Record<string, unknown>> = [];

  for (const item of targets) {
    await supabase
      .from("opportunity_scan_settings")
      .update({
        last_status: "running",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", item.project_id)
      .eq("owner_id", item.owner_id);

    const { data: job } = await supabase
      .from("jobs")
      .insert({
        project_id: item.project_id,
        owner_id: item.owner_id,
        job_type: "warehouse_opportunity_scan",
        trigger_type: "scheduled",
        status: "running",
        payload: {
          scan_gsc: item.scan_gsc,
          scan_ga4: item.scan_ga4,
          scan_rank: item.scan_rank,
        },
        started_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();

    try {
      const scan = await detectWarehouseOpportunities({
        ownerId: item.owner_id,
        projectId: item.project_id,
        scanGsc: item.scan_gsc,
        scanGa4: item.scan_ga4,
        scanRank: item.scan_rank,
        client: supabase,
      });

      const status =
        scan.gscReady || scan.gscQueryPageReady || scan.ga4Ready
          ? "succeeded"
          : "partial";

      await supabase
        .from("opportunity_scan_settings")
        .update({
          last_run_at: new Date().toISOString(),
          last_data_date: scan.dataDate,
          last_status: status,
          last_error:
            status === "partial"
              ? "Warehouse data exists or is still syncing, but coverage is not yet sufficient for the enabled Opportunity Engine rules."
              : null,
          consecutive_failures: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", item.project_id)
        .eq("owner_id", item.owner_id);

      if (job?.id) {
        await supabase
          .from("jobs")
          .update({
            status,
            result_summary: scan,
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      }

      results.push({
        project_id: item.project_id,
        status,
        ...scan,
      });
    } catch (scanError) {
      const message =
        scanError instanceof Error
          ? scanError.message
          : "Automatic opportunity scan failed.";
      const failures = Number(item.consecutive_failures || 0) + 1;

      await supabase
        .from("opportunity_scan_settings")
        .update({
          last_run_at: new Date().toISOString(),
          last_status: "failed",
          last_error: message,
          consecutive_failures: failures,
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", item.project_id)
        .eq("owner_id", item.owner_id);

      if (job?.id) {
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            result_summary: { error: message },
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      }

      results.push({
        project_id: item.project_id,
        status: "failed",
        error: message,
      });
    }
  }

  return NextResponse.json({
    recovered_stale_jobs: recoveredStaleJobs,
    configured: settings?.length || 0,
    due: targets.length,
    processed: results.length,
    results,
    time: new Date().toISOString(),
  });
}

// Vercel Cron invokes production cron routes with GET.
export async function GET(request: NextRequest) {
  return POST(request);
}
