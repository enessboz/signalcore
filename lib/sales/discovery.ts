import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchGoogleOrganicSerp } from "@/lib/seo/dataforseo";
import { createClient } from "@/lib/supabase/server";

const DEFAULT_BLOCKED = new Set([
  "google.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
  "reddit.com",
  "yelp.com",
  "clutch.co",
  "designrush.com",
]);

function normalizeDomain(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = value.includes("://") ? new URL(value) : new URL("https://" + value);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] || null;
  }
}

function titleCompanyName(title: string | null | undefined, domain: string) {
  const first = (title || "")
    .split(/\s+[|–—-]\s+/)[0]
    ?.trim()
    .replace(/\b(home|official site|website)\b/gi, "")
    .trim();

  if (first && first.length >= 2 && first.length <= 80) return first;
  return domain
    .split(".")[0]
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function initialBreakdown(rank: number | null) {
  const serpOpportunity =
    rank === null ? 15 : rank <= 3 ? 8 : rank <= 10 ? 14 : rank <= 20 ? 22 : 28;

  return {
    serp_opportunity: serpOpportunity,
    business_fit: 25,
    web_presence: 10,
    technical_opportunity: 0,
    contactability: 0,
  };
}

function sumScore(breakdown: Record<string, number>) {
  return Math.min(
    Object.values(breakdown).reduce((sum, value) => sum + Number(value || 0), 0),
    100,
  );
}

export async function runSalesDiscoveryCampaign(input: {
  ownerId: string;
  campaignId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: campaign, error: campaignError } = await supabase
    .from("sales_campaigns")
    .select("id,name,status,country,industry,location_code,language_code,queries,exclusions,depth,min_score,max_candidates,max_run_cost_usd,monthly_budget_usd,monthly_budget_hard_stop")
    .eq("id", input.campaignId)
    .eq("owner_id", input.ownerId)
    .single();

  if (campaignError || !campaign) {
    throw new Error(campaignError?.message || "Sales campaign not found.");
  }

  const queries = Array.isArray(campaign.queries)
    ? campaign.queries.map(String).map((q) => q.trim()).filter(Boolean).slice(0, 10)
    : [];

  if (!queries.length) throw new Error("Sales campaign has no discovery queries.");

  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  ).toISOString();
  const { data: monthlyRuns, error: monthlyRunsError } = await supabase
    .from("sales_discovery_runs")
    .select("actual_cost")
    .eq("campaign_id", campaign.id)
    .eq("owner_id", input.ownerId)
    .gte("started_at", monthStart);

  if (monthlyRunsError) {
    throw new Error("Monthly sales budget usage could not be loaded: " + monthlyRunsError.message);
  }

  const monthlySpentBeforeRun = (monthlyRuns || []).reduce(
    (sum, item) => sum + Number(item.actual_cost || 0),
    0,
  );

  const { data: run, error: runError } = await supabase
    .from("sales_discovery_runs")
    .insert({
      campaign_id: campaign.id,
      owner_id: input.ownerId,
      status: "running",
      queries_requested: queries.length,
    })
    .select("id")
    .single();

  if (runError || !run) {
    throw new Error(runError?.message || "Discovery run could not be created.");
  }

  const customExclusions = new Set(
    (Array.isArray(campaign.exclusions) ? campaign.exclusions : [])
      .map((item) => normalizeDomain(String(item)))
      .filter(Boolean) as string[],
  );

  const seen = new Map<
    string,
    {
      domain: string;
      companyName: string;
      query: string;
      rank: number | null;
      url: string | null;
      breakdown: Record<string, number>;
    }
  >();

  let actualCost = 0;
  let completedQueries = 0;
  let candidatesSeen = 0;
  let partialReason: string | null = null;
  const conservativeCost = Math.max(
    Number(process.env.SERP_ESTIMATED_COST_PER_REQUEST_USD || "0.01"),
    0,
  );

  try {
    for (const query of queries) {
      const projectedMonthlySpend =
        monthlySpentBeforeRun + actualCost + conservativeCost;

      if (
        campaign.monthly_budget_hard_stop &&
        projectedMonthlySpend > Number(campaign.monthly_budget_usd || 0)
      ) {
        partialReason =
          "Campaign monthly budget hard-stop reached before the next SERP request.";
        break;
      }

      if (actualCost + conservativeCost > Number(campaign.max_run_cost_usd || 0)) {
        partialReason = "Campaign max run cost reached before the next SERP request.";
        break;
      }

      const result = await fetchGoogleOrganicSerp({
        keyword: query,
        locationCode: campaign.location_code,
        languageCode: campaign.language_code,
        depth: campaign.depth,
      });

      actualCost += Number(result.cost || 0);
      completedQueries += 1;
      candidatesSeen += result.organic.length;

      for (const item of result.organic) {
        if (seen.size >= campaign.max_candidates) break;

        const domain = normalizeDomain(item.domain || item.url);
        if (!domain) continue;
        if (DEFAULT_BLOCKED.has(domain) || customExclusions.has(domain)) continue;

        const existingCandidate = seen.get(domain);
        const rank = item.rank ? Number(item.rank) : null;

        if (
          existingCandidate &&
          existingCandidate.rank !== null &&
          rank !== null &&
          existingCandidate.rank <= rank
        ) {
          continue;
        }

        const breakdown = initialBreakdown(rank);
        seen.set(domain, {
          domain,
          companyName: titleCompanyName(item.title, domain),
          query,
          rank,
          url: item.url,
          breakdown,
        });
      }

      if (seen.size >= campaign.max_candidates) break;
    }

    const domains = [...seen.keys()];
    const { data: existingLeads } = domains.length
      ? await supabase
          .from("sales_leads")
          .select("id,domain,score,score_breakdown,stage,qualification_status")
          .eq("owner_id", input.ownerId)
          .in("domain", domains)
      : { data: [] };

    const existingByDomain = new Map(
      (existingLeads || []).map((lead) => [lead.domain, lead]),
    );

    let leadsCreated = 0;
    let leadsLinked = 0;

    for (const candidate of seen.values()) {
      const initialScore = sumScore(candidate.breakdown);
      let leadId: string;

      const existing = existingByDomain.get(candidate.domain);
      if (!existing) {
        const { data: lead, error } = await supabase
          .from("sales_leads")
          .insert({
            owner_id: input.ownerId,
            domain: candidate.domain,
            company_name: candidate.companyName,
            country: campaign.country,
            industry: campaign.industry,
            stage: "discovered",
            qualification_status: "pending",
            score: initialScore,
            score_breakdown: candidate.breakdown,
            evidence: {
              discovery: {
                source: "dataforseo_serp",
                query: candidate.query,
                rank: candidate.rank,
                url: candidate.url,
              },
            },
          })
          .select("id")
          .single();

        if (error || !lead) throw new Error(error?.message || "Lead insert failed.");
        leadId = lead.id;
        leadsCreated += 1;
      } else {
        leadId = existing.id;
        if (
          existing.qualification_status === "pending" &&
          initialScore > Number(existing.score || 0)
        ) {
          await supabase
            .from("sales_leads")
            .update({
              company_name: candidate.companyName,
              country: campaign.country || undefined,
              industry: campaign.industry || undefined,
              score: initialScore,
              score_breakdown: candidate.breakdown,
              updated_at: new Date().toISOString(),
            })
            .eq("id", leadId)
            .eq("owner_id", input.ownerId);
        }
      }

      const { error: linkError } = await supabase
        .from("sales_campaign_leads")
        .upsert(
          {
            campaign_id: campaign.id,
            lead_id: leadId,
            owner_id: input.ownerId,
            source_query: candidate.query,
            source_rank: candidate.rank,
            source_url: candidate.url,
          },
          { onConflict: "campaign_id,lead_id" },
        );

      if (linkError) throw new Error(linkError.message);
      leadsLinked += 1;
    }

    const status = partialReason ? "partial" : "succeeded";
    await supabase
      .from("sales_discovery_runs")
      .update({
        status,
        queries_completed: completedQueries,
        candidates_seen: candidatesSeen,
        leads_created: leadsCreated,
        leads_linked: leadsLinked,
        actual_cost: actualCost,
        result: {
          unique_candidates: seen.size,
          partial_reason: partialReason,
          monthly_spent_before_run: monthlySpentBeforeRun,
          monthly_spent_after_run: monthlySpentBeforeRun + actualCost,
          monthly_budget_usd: Number(campaign.monthly_budget_usd || 0),
          monthly_budget_hard_stop: Boolean(campaign.monthly_budget_hard_stop),
        },
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    await supabase
      .from("sales_campaigns")
      .update({
        status: "active",
        last_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .eq("owner_id", input.ownerId);

    return {
      runId: run.id as string,
      status,
      completedQueries,
      uniqueCandidates: seen.size,
      leadsCreated,
      leadsLinked,
      actualCost,
      partialReason,
      monthlySpentBeforeRun,
      monthlySpentAfterRun: monthlySpentBeforeRun + actualCost,
      monthlyBudget: Number(campaign.monthly_budget_usd || 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sales discovery failed.";
    await supabase
      .from("sales_discovery_runs")
      .update({
        status: completedQueries ? "partial" : "failed",
        queries_completed: completedQueries,
        candidates_seen: candidatesSeen,
        actual_cost: actualCost,
        error: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw error;
  }
}
