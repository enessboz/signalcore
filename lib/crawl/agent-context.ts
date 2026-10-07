import type { SupabaseClient } from "@supabase/supabase-js";

export async function buildTechnicalCrawlAgentContext(input: {
  client: SupabaseClient;
  projectId: string;
  ownerId: string;
}) {
  const { data: latestRun, error: runError } = await input.client
    .from("crawl_runs")
    .select("id,crawl_type,status,execution_mode,max_urls,pages_discovered,pages_crawled,error_count,summary,robots_compliant,js_render_mode,started_at,completed_at")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .in("status", ["succeeded", "partial"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) {
    throw new Error("Technical crawl context could not be loaded: " + runError.message);
  }

  if (!latestRun?.id) {
    return {
      policy:
        "No completed deterministic crawl is available. Do not invent technical crawl evidence or infer unseen pages.",
      latest_run: null,
      benchmark: null,
      robots: null,
      deterministic_findings: [],
      performance_samples: [],
      page_samples: [],
    };
  }

  const [
    { data: benchmark },
    { data: robots },
    { data: findings },
    { data: performance },
    { data: pageSamples },
  ] = await Promise.all([
    input.client.rpc("get_crawl_run_benchmark", {
      p_run_id: latestRun.id,
    }),
    input.client
      .from("crawl_robots_audits")
      .select("robots_url,status_code,fetch_status,rules,sitemap_urls,crawl_delay_ms,blocks_all,error,fetched_at")
      .eq("crawl_run_id", latestRun.id)
      .maybeSingle(),
    input.client
      .from("findings")
      .select("id,finding_type,title,summary,why_it_matters,importance,confidence,affected_scope,recommended_action,metadata")
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .eq("metadata->>crawl_run_id", latestRun.id)
      .in("status", ["open", "monitoring"])
      .order("importance")
      .limit(60),
    input.client
      .from("crawl_performance_results")
      .select("url,strategy,performance_score,lcp_ms,cls,inp_ms,fcp_ms,tbt_ms,field_data,fetched_at")
      .eq("crawl_run_id", latestRun.id)
      .order("fetched_at", { ascending: false })
      .limit(20),
    input.client
      .from("crawl_pages")
      .select("requested_url,final_url,status_code,title,canonical,robots_meta,x_robots_tag,indexable,indexability_reason,crawl_depth,inlink_count,sitemap_present,orphan_candidate,word_count,internal_link_count,content_simhash,near_duplicate_group,rendered,render_reason,fetch_error")
      .eq("crawl_run_id", latestRun.id)
      .order("status_code", { ascending: false, nullsFirst: false })
      .order("inlink_count", { ascending: false })
      .limit(40),
  ]);

  return {
    policy:
      "DETERMINISTIC CRAWLER SEPARATION: Treat the crawler and rule engine as the source of raw technical observations. Do not crawl URLs, simulate browser fetches, invent missing pages, or replace deterministic detection with model guesses. Your role is to cluster related evidence, identify likely root causes, explain scope and business/search impact, prioritize remediation, and propose validation steps. Preserve uncertainty and distinguish observed facts from hypotheses.",
    latest_run: latestRun,
    benchmark: benchmark || null,
    robots: robots || null,
    deterministic_findings: findings || [],
    performance_samples: performance || [],
    page_samples: pageSamples || [],
  };
}
