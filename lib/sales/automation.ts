import type { SupabaseClient } from "@supabase/supabase-js";
import { qualifySalesLead } from "@/lib/sales/qualification";
import { createClient } from "@/lib/supabase/server";

export async function qualifyTopCampaignLeads(input: {
  ownerId: string;
  campaignId: string;
  limit?: number;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const limit = Math.min(Math.max(input.limit || 5, 0), 10);
  if (!limit) return { requested: 0, succeeded: 0, failed: 0, errors: [] as string[] };

  const { data: links, error: linkError } = await supabase
    .from("sales_campaign_leads")
    .select("lead_id")
    .eq("campaign_id", input.campaignId)
    .eq("owner_id", input.ownerId)
    .order("discovered_at", { ascending: false })
    .limit(200);

  if (linkError) throw new Error(linkError.message);
  const leadIds = Array.from(new Set((links || []).map((row) => row.lead_id)));
  if (!leadIds.length) {
    return { requested: 0, succeeded: 0, failed: 0, errors: [] as string[] };
  }

  const { data: leads, error: leadError } = await supabase
    .from("sales_leads")
    .select("id,score,qualification_status")
    .eq("owner_id", input.ownerId)
    .in("id", leadIds);

  if (leadError) throw new Error(leadError.message);

  const targets = (leads || [])
    .filter((lead) => lead.qualification_status === "pending")
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);

  let succeeded = 0;
  const errors: string[] = [];

  for (const lead of targets) {
    try {
      await qualifySalesLead({
        ownerId: input.ownerId,
        leadId: lead.id,
        client: supabase,
      });
      succeeded += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Qualification failed.");
    }
  }

  return {
    requested: targets.length,
    succeeded,
    failed: errors.length,
    errors,
  };
}
