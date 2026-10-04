import type { SupabaseClient } from "@supabase/supabase-js";
import { crawlPage, discoverSitemapUrls, type CrawledPage } from "@/lib/crawl/http-crawler";
import { createClient } from "@/lib/supabase/server";

type CrawlType = "http" | "prospect_audit" | "delta";

type CrawlFinding = {
  fingerprint: string;
  title: string;
  summary: string;
  importance: "critical" | "high" | "medium" | "low";
  affectedScope: Record<string, unknown>;
  recommendedAction: string;
  metadata: Record<string, unknown>;
};

function pageFindings(page: CrawledPage): CrawlFinding[] {
  const out: CrawlFinding[] = [];
  const key = encodeURIComponent(page.url).slice(0, 400);

  if (page.fetchError) {
    out.push({
      fingerprint: "crawl:fetch-error:" + key,
      title: "Page could not be fetched",
      summary: page.url + " — " + page.fetchError,
      importance: "high",
      affectedScope: { url: page.url },
      recommendedAction: "Verify DNS, server availability, redirects and whether the page intentionally blocks controlled crawlers.",
      metadata: { rule: "fetch_error", status_code: page.statusCode },
    });
    return out;
  }

  if (page.statusCode && page.statusCode >= 400) {
    out.push({
      fingerprint: "crawl:http-status:" + key,
      title: "Non-success HTTP status",
      summary: page.url + " returned HTTP " + page.statusCode + ".",
      importance: page.statusCode >= 500 ? "high" : "medium",
      affectedScope: { url: page.url },
      recommendedAction: "Confirm whether the URL should be indexable or linked internally, then fix the response, redirect or references as appropriate.",
      metadata: { rule: "http_status", status_code: page.statusCode },
    });
  }

  if (page.statusCode === 200 && !page.title) {
    out.push({
      fingerprint: "crawl:missing-title:" + key,
      title: "Missing title element",
      summary: page.url + " has no parsed HTML title.",
      importance: "medium",
      affectedScope: { url: page.url },
      recommendedAction: "Add a concise, intent-aligned unique title if the page is intended for search.",
      metadata: { rule: "missing_title" },
    });
  }

  if (page.statusCode === 200 && page.h1s.length === 0) {
    out.push({
      fingerprint: "crawl:missing-h1:" + key,
      title: "Missing H1",
      summary: page.url + " has no H1 in the fetched HTML.",
      importance: "medium",
      affectedScope: { url: page.url },
      recommendedAction: "Verify rendered HTML and add one clear primary heading if the page template requires it.",
      metadata: { rule: "missing_h1" },
    });
  }

  if (page.h1s.length > 1) {
    out.push({
      fingerprint: "crawl:multiple-h1:" + key,
      title: "Multiple H1 elements",
      summary: page.url + " exposes " + page.h1s.length + " H1 elements in fetched HTML.",
      importance: "low",
      affectedScope: { url: page.url, h1s: page.h1s.slice(0, 10) },
      recommendedAction: "Review whether headings represent one primary topic or template duplication before changing markup.",
      metadata: { rule: "multiple_h1" },
    });
  }

  if (page.statusCode === 200 && !page.canonical) {
    out.push({
      fingerprint: "crawl:missing-canonical:" + key,
      title: "Canonical not detected",
      summary: page.url + " has no canonical link in fetched HTML.",
      importance: "low",
      affectedScope: { url: page.url },
      recommendedAction: "Confirm canonical policy for this template and add a canonical when appropriate.",
      metadata: { rule: "missing_canonical" },
    });
  }

  if (page.robotsMeta?.toLowerCase().includes("noindex")) {
    out.push({
      fingerprint: "crawl:noindex:" + key,
      title: "Noindex detected",
      summary: page.url + " contains a noindex robots directive.",
      importance: "medium",
      affectedScope: { url: page.url, robots_meta: page.robotsMeta },
      recommendedAction: "Confirm whether exclusion is intentional. If the URL should rank, remove the directive only after checking template and canonical logic.",
      metadata: { rule: "noindex" },
    });
  }

  if (page.responseMs && page.responseMs >= 3000) {
    out.push({
      fingerprint: "crawl:slow-response:" + key,
      title: "Slow HTTP response",
      summary: page.url + " took approximately " + page.responseMs + " ms to fetch.",
      importance: "low",
      affectedScope: { url: page.url },
      recommendedAction: "Validate with performance tooling and server telemetry before treating this single crawl sample as a persistent performance issue.",
      metadata: { rule: "slow_response", response_ms: page.responseMs },
    });
  }

  return out;
}

function duplicateTitleFindings(pages: CrawledPage[]): CrawlFinding[] {
  const grouped = new Map<string, string[]>();
  for (const page of pages) {
    const title = page.title?.trim().toLowerCase();
    if (!title || page.statusCode !== 200) continue;
    const list = grouped.get(title) || [];
    list.push(page.url);
    grouped.set(title, list);
  }

  const findings: CrawlFinding[] = [];
  for (const [title, urls] of grouped) {
    if (urls.length < 2) continue;
    const fingerprintKey = encodeURIComponent(title).slice(0, 300);
    findings.push({
      fingerprint: "crawl:duplicate-title:" + fingerprintKey,
      title: "Duplicate title across crawled pages",
      summary: urls.length + " crawled URLs share the same title: " + title,
      importance: urls.length >= 5 ? "medium" : "low",
      affectedScope: { urls: urls.slice(0, 25), title },
      recommendedAction: "Check whether the URLs target distinct intents. Rewrite titles only when duplication reflects weak differentiation rather than intentional pagination or variants.",
      metadata: { rule: "duplicate_title", url_count: urls.length },
    });
  }
  return findings;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

export async function runProjectCrawl(input: {
  ownerId: string;
  projectId: string;
  maxUrls?: number;
  crawlType?: CrawlType;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const maxUrls = Math.min(Math.max(input.maxUrls || 100, 1), 500);
  const crawlType = input.crawlType || "http";

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,name,domain,project_type")
    .eq("id", input.projectId)
    .eq("owner_id", input.ownerId)
    .single();

  if (projectError || !project?.domain) {
    throw new Error(projectError?.message || "Project domain is required for crawling.");
  }

  const seedUrl = project.domain.startsWith("http")
    ? project.domain
    : "https://" + project.domain;

  const { data: run, error: runError } = await supabase
    .from("crawl_runs")
    .insert({
      project_id: input.projectId,
      owner_id: input.ownerId,
      crawl_type: crawlType,
      status: "running",
      seed_url: seedUrl,
      max_urls: maxUrls,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (runError || !run) {
    throw new Error(runError?.message || "Crawl run could not be created.");
  }

  try {
    const discovery = await discoverSitemapUrls(seedUrl, maxUrls);
    const pages = await mapLimit(discovery.urls, 5, (url) =>
      crawlPage(url, discovery.origin),
    );

    const pageRows = pages.map((page) => ({
      crawl_run_id: run.id,
      project_id: input.projectId,
      owner_id: input.ownerId,
      url: page.url,
      status_code: page.statusCode,
      response_ms: page.responseMs,
      content_type: page.contentType,
      title: page.title,
      meta_description: page.metaDescription,
      canonical: page.canonical,
      robots_meta: page.robotsMeta,
      h1s: page.h1s,
      h2s: page.h2s,
      word_count: page.wordCount,
      internal_link_count: page.internalLinkCount,
      external_link_count: page.externalLinkCount,
      image_count: page.imageCount,
      missing_alt_count: page.missingAltCount,
      structured_data_count: page.structuredDataCount,
      content_hash: page.contentHash,
      fetch_error: page.fetchError,
      metadata: page.metadata,
    }));

    if (pageRows.length) {
      const { error: insertError } = await supabase.from("crawl_pages").insert(pageRows);
      if (insertError) throw insertError;
    }

    const findings = [
      ...pages.flatMap(pageFindings),
      ...duplicateTitleFindings(pages),
    ].slice(0, 500);

    if (findings.length) {
      const now = new Date().toISOString();
      const { error: findingError } = await supabase.from("findings").upsert(
        findings.map((finding) => ({
          project_id: input.projectId,
          owner_id: input.ownerId,
          finding_type: "issue",
          title: finding.title,
          summary: finding.summary,
          why_it_matters:
            "This was detected from direct HTTP crawl evidence and should be validated in the context of the affected template and search intent.",
          importance: finding.importance,
          confidence: "high",
          status: "open",
          fingerprint: finding.fingerprint,
          affected_scope: finding.affectedScope,
          recommended_action: finding.recommendedAction,
          metadata: {
            source: "http_crawl",
            detector: "technical_rule_engine_v1",
            crawl_run_id: run.id,
            ...finding.metadata,
          },
          last_seen_at: now,
          updated_at: now,
        })),
        { onConflict: "project_id,fingerprint" },
      );
      if (findingError) throw findingError;
    }

    const errors = pages.filter(
      (page) => page.fetchError || (page.statusCode && page.statusCode >= 400),
    ).length;
    const indexableCandidates = pages.filter(
      (page) =>
        page.statusCode === 200 &&
        !page.robotsMeta?.toLowerCase().includes("noindex"),
    ).length;

    const summary = {
      sitemap_count: discovery.sitemapCount,
      pages_discovered: discovery.urls.length,
      pages_crawled: pages.length,
      fetch_or_http_errors: errors,
      indexable_candidates: indexableCandidates,
      finding_count: findings.length,
      avg_response_ms:
        pages.filter((page) => page.responseMs).length
          ? Math.round(
              pages.reduce((sum, page) => sum + (page.responseMs || 0), 0) /
                pages.filter((page) => page.responseMs).length,
            )
          : null,
    };

    await supabase
      .from("crawl_runs")
      .update({
        status: errors === pages.length && pages.length ? "partial" : "succeeded",
        pages_discovered: discovery.urls.length,
        pages_crawled: pages.length,
        error_count: errors,
        summary,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    return { runId: run.id as string, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crawl failed.";
    await supabase
      .from("crawl_runs")
      .update({
        status: "failed",
        summary: { error: message },
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw error;
  }
}
