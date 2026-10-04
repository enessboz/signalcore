"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { detectWarehouseOpportunities } from "@/lib/rules/warehouse-opportunities";

export async function setFindingStatus(
  findingId: string,
  status: "open" | "monitoring" | "resolved" | "dismissed",
  returnTo = "/opportunities",
) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase
    .from("findings")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", findingId)
    .eq("owner_id", ownerId);

  if (error) {
    redirect(`${returnTo}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/opportunities");
  redirect(`${returnTo}?message=${encodeURIComponent(`Finding marked ${status}`)}`);
}


export async function saveOpportunityAutomation(formData: FormData) {
  const projectId = String(formData.get("projectId") || "").trim();
  const enabled = formData.get("enabled") === "on";
  const scanGsc = formData.get("scanGsc") === "on";
  const scanGa4 = formData.get("scanGa4") === "on";
  const scanRank = formData.get("scanRank") === "on";
  const cadence =
    String(formData.get("cadence") || "daily") === "weekly"
      ? "weekly"
      : "daily";

  if (!projectId) {
    redirect("/opportunities?error=Project%20is%20required");
  }
  if (enabled && !scanGsc && !scanGa4 && !scanRank) {
    redirect(
      "/opportunities?error=Enable%20at%20least%20one%20opportunity%20source",
    );
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { error } = await supabase.from("opportunity_scan_settings").upsert(
    {
      project_id: projectId,
      owner_id: ownerId,
      enabled,
      scan_gsc: scanGsc,
      scan_ga4: scanGa4,
      scan_rank: scanRank,
      cadence,
      last_status: enabled ? "idle" : "paused",
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  if (error) {
    redirect("/opportunities?error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/opportunities");
  revalidatePath("/automations");
  redirect(
    "/opportunities?project=" +
      projectId +
      "&message=" +
      encodeURIComponent(
        enabled
          ? "Automatic Opportunity Engine enabled"
          : "Automatic Opportunity Engine paused",
      ),
  );
}

export async function runWarehouseOpportunityScan(projectId: string) {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  const { data: settings } = await supabase
    .from("opportunity_scan_settings")
    .select("scan_gsc,scan_ga4,scan_rank")
    .eq("project_id", projectId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  try {
    const result = await detectWarehouseOpportunities({
      ownerId,
      projectId,
      scanGsc: settings?.scan_gsc !== false,
      scanGa4: settings?.scan_ga4 !== false,
      scanRank: settings?.scan_rank !== false,
      client: supabase,
    });

    await supabase.from("opportunity_scan_settings").upsert(
      {
        project_id: projectId,
        owner_id: ownerId,
        last_run_at: new Date().toISOString(),
        last_data_date: result.dataDate,
        last_status:
          result.gscAvailable || result.ga4Available ? "succeeded" : "partial",
        last_error: null,
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id" },
    );

    revalidatePath("/opportunities");
    redirect(
      "/opportunities?project=" +
        projectId +
        "&message=" +
        encodeURIComponent(
          "Opportunity scan complete: " +
            String(result.candidates) +
            " candidates · " +
            String(result.high) +
            " high importance",
        ),
    );
  } catch (error) {
    redirect(
      "/opportunities?project=" +
        projectId +
        "&error=" +
        encodeURIComponent(
          error instanceof Error ? error.message : "Opportunity scan failed",
        ),
    );
  }
}
