import type { SupabaseClient } from "@supabase/supabase-js";
import {
  crawlPage,
  discoverSitemapUrls,
  type CrawledPage,
} from "@/lib/crawl/http-crawler";
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

type PageGraphState = {
  page: CrawledPage;
  requestedNormalized: string;
  finalNormalized: string;
  crawlDepth: number | null;
  inlinkCount: number;
  sitemapPresent: boolean;
  orphanCandidate: boolean;
};

function normalizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

function findingKey(value: string) {
  return encodeURIComponent(value).slice(0, 420);
}

function pageFindings(state: PageGraphState): CrawlFinding[] {
  const page = state.page;
  const out: CrawlFinding[] = [];
  const key = findingKey(page.requestedUrl);

  if (page.fetchError) {
    out.push({
      fingerprint: "crawl:fetch-error:" + key,
      title: "Page could not be fetched",
      summary: page.requestedUrl + " — " + page.fetchError,
      importance: "high",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Verify DNS, server availability, redirect behavior and whether the URL intentionally blocks controlled crawlers.",
      metadata: {
        rule: "fetch_error",
        status_code: page.statusCode,
      },
    });
    return out;
  }

  if (page.statusCode && page.statusCode >= 400) {
    out.push({
      fingerprint: "crawl:http-status:" + key,
      title: "Non-success HTTP status",
      summary: page.requestedUrl + " returned HTTP " + page.statusCode + ".",
      importance: page.statusCode >= 500 ? "high" : "medium",
      affectedScope: {
        url: page.requestedUrl,
        final_url: page.url,
      },
      recommendedAction:
        "Confirm whether the URL should be indexable or linked internally, then fix the response, redirect or references as appropriate.",
      metadata: {
        rule: "http_status",
        status_code: page.statusCode,
      },
    });
  }

  if (page.redirectChain.length >= 2) {
    out.push({
      fingerprint: "crawl:redirect-chain:" + key,
      title: "Redirect chain detected",
      summary:
        page.requestedUrl +
        " passes through " +
        page.redirectChain.length +
        " redirect hops before the final response.",
      importance: page.redirectChain.length >= 3 ? "medium" : "low",
      affectedScope: {
        url: page.requestedUrl,
        final_url: page.url,
        redirect_chain: page.redirectChain,
      },
      recommendedAction:
        "Update internal references to point directly to the preferred final URL and remove avoidable redirect hops.",
      metadata: {
        rule: "redirect_chain",
        redirect_count: page.redirectChain.length,
      },
    });
  }

  if (page.statusCode === 200 && !page.title) {
    out.push({
      fingerprint: "crawl:missing-title:" + key,
      title: "Missing title element",
      summary: page.requestedUrl + " has no parsed HTML title.",
      importance: "medium",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Add a concise, intent-aligned unique title if the page is intended for search.",
      metadata: { rule: "missing_title" },
    });
  }

  if (page.statusCode === 200 && !page.metaDescription) {
    out.push({
      fingerprint: "crawl:missing-meta-description:" + key,
      title: "Meta description not detected",
      summary: page.requestedUrl + " has no parsed meta description.",
      importance: "low",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Add a useful description for important indexable pages when the template and search intent justify it.",
      metadata: { rule: "missing_meta_description" },
    });
  }

  if (page.statusCode === 200 && page.h1s.length === 0) {
    out.push({
      fingerprint: "crawl:missing-h1:" + key,
      title: "Missing H1",
      summary: page.requestedUrl + " has no H1 in the fetched HTML.",
      importance: "medium",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Verify rendered HTML and add one clear primary heading if the page template requires it.",
      metadata: { rule: "missing_h1" },
    });
  }

  if (page.h1s.length > 1) {
    out.push({
      fingerprint: "crawl:multiple-h1:" + key,
      title: "Multiple H1 elements",
      summary:
        page.requestedUrl +
        " exposes " +
        page.h1s.length +
        " H1 elements in fetched HTML.",
      importance: "low",
      affectedScope: {
        url: page.requestedUrl,
        h1s: page.h1s.slice(0, 10),
      },
      recommendedAction:
        "Review whether headings represent one primary topic or template duplication before changing markup.",
      metadata: { rule: "multiple_h1" },
    });
  }

  if (page.statusCode === 200 && !page.canonical) {
    out.push({
      fingerprint: "crawl:missing-canonical:" + key,
      title: "Canonical not detected",
      summary: page.requestedUrl + " has no canonical link in fetched HTML.",
      importance: "low",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Confirm canonical policy for this template and add a canonical when appropriate.",
      metadata: { rule: "missing_canonical" },
    });
  }

  const robots = [page.robotsMeta, page.xRobotsTag]
    .filter(Boolean)
    .join(",")
    .toLowerCase();

  if (robots.includes("noindex")) {
    out.push({
      fingerprint: "crawl:noindex:" + key,
      title: "Noindex detected",
      summary: page.requestedUrl + " is excluded by a robots noindex directive.",
      importance: "medium",
      affectedScope: {
        url: page.requestedUrl,
        robots_meta: page.robotsMeta,
        x_robots_tag: page.xRobotsTag,
      },
      recommendedAction:
        "Confirm whether exclusion is intentional. If the URL should rank, remove the directive only after checking template and canonical logic.",
      metadata: { rule: "noindex" },
    });
  }

  if (page.metaRefresh) {
    out.push({
      fingerprint: "crawl:meta-refresh:" + key,
      title: "Meta refresh detected",
      summary:
        page.requestedUrl +
        " contains a meta refresh directive: " +
        page.metaRefresh +
        ".",
      importance: "medium",
      affectedScope: {
        url: page.requestedUrl,
        meta_refresh: page.metaRefresh,
      },
      recommendedAction:
        "Prefer an appropriate HTTP redirect where redirection is intended, and verify the page is not relying on refresh behavior for canonical navigation.",
      metadata: { rule: "meta_refresh" },
    });
  }

  if (page.invalidStructuredDataCount > 0) {
    out.push({
      fingerprint: "crawl:invalid-jsonld:" + key,
      title: "Invalid JSON-LD block detected",
      summary:
        page.requestedUrl +
        " contains " +
        page.invalidStructuredDataCount +
        " JSON-LD block(s) that could not be parsed as JSON.",
      importance: "medium",
      affectedScope: {
        url: page.requestedUrl,
        invalid_count: page.invalidStructuredDataCount,
      },
      recommendedAction:
        "Validate the affected JSON-LD block and correct malformed JSON before reviewing schema eligibility.",
      metadata: {
        rule: "invalid_jsonld",
        invalid_count: page.invalidStructuredDataCount,
      },
    });
  }

  if (
    page.imageCount >= 3 &&
    page.missingAltCount > 0 &&
    page.missingAltCount / page.imageCount >= 0.3
  ) {
    out.push({
      fingerprint: "crawl:missing-alt-ratio:" + key,
      title: "High share of images without alt text",
      summary:
        page.requestedUrl +
        " has " +
        page.missingAltCount +
        " of " +
        page.imageCount +
        " images without non-empty alt text.",
      importance: "low",
      affectedScope: {
        url: page.requestedUrl,
        image_count: page.imageCount,
        missing_alt_count: page.missingAltCount,
      },
      recommendedAction:
        "Review meaningful images for concise alternative text while leaving purely decorative images appropriately empty.",
      metadata: { rule: "missing_alt_ratio" },
    });
  }

  if (
    page.statusCode === 200 &&
    page.contentType?.toLowerCase().includes("text/html") &&
    !page.htmlLang
  ) {
    out.push({
      fingerprint: "crawl:missing-html-lang:" + key,
      title: "HTML language not detected",
      summary: page.requestedUrl + " has no lang attribute on the html element.",
      importance: "low",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Set the document language when the page template serves a known language.",
      metadata: { rule: "missing_html_lang" },
    });
  }

  if (page.responseMs && page.responseMs >= 3000) {
    out.push({
      fingerprint: "crawl:slow-response:" + key,
      title: "Slow HTTP response",
      summary:
        page.requestedUrl +
        " took approximately " +
        page.responseMs +
        " ms to fetch.",
      importance: "low",
      affectedScope: { url: page.requestedUrl },
      recommendedAction:
        "Validate with performance tooling and server telemetry before treating this single crawl sample as a persistent performance issue.",
      metadata: {
        rule: "slow_response",
        response_ms: page.responseMs,
      },
    });
  }

  if (
    state.crawlDepth !== null &&
    state.crawlDepth >= 4 &&
    page.indexable
  ) {
    out.push({
      fingerprint: "crawl:deep-page:" + key,
      title: "Deep crawl depth",
      summary:
        page.requestedUrl +
        " is " +
        state.crawlDepth +
        " internal-link hops from the homepage in this crawl sample.",
      importance: state.crawlDepth >= 6 ? "medium" : "low",
      affectedScope: {
        url: page.requestedUrl,
        crawl_depth: state.crawlDepth,
      },
      recommendedAction:
        "Review whether this important page should receive a shorter, more contextual internal-link path from relevant hubs.",
      metadata: {
        rule: "crawl_depth",
        crawl_depth: state.crawlDepth,
      },
    });
  }

  if (state.orphanCandidate && page.indexable) {
    out.push({
      fingerprint: "crawl:orphan-candidate:" + key,
      title: "Orphan page candidate",
      summary:
        page.requestedUrl +
        " is present in the sitemap sample but received no crawlable internal-link path from the homepage.",
      importance: "medium",
      affectedScope: {
        url: page.requestedUrl,
        sitemap_present: true,
        inlink_count: state.inlinkCount,
      },
      recommendedAction:
        "Confirm against a full crawl and first-party page inventory, then add contextual internal links if the page should be discoverable through site architecture.",
      metadata: { rule: "orphan_candidate" },
    });
  }

  return out;
}

function groupedDuplicateFinding(input: {
  pages: PageGraphState[];
  selector: (page: CrawledPage) => string | null;
  rule: string;
  title: string;
  label: string;
}): CrawlFinding[] {
  const grouped = new Map<string, string[]>();

  for (const state of input.pages) {
    if (state.page.statusCode !== 200) continue;
    const value = input.selector(state.page)?.trim().toLowerCase();
    if (!value) continue;
    const list = grouped.get(value) || [];
    list.push(state.page.requestedUrl);
    grouped.set(value, list);
  }

  const findings: CrawlFinding[] = [];
  for (const [value, urls] of grouped) {
    if (urls.length < 2) continue;

    findings.push({
      fingerprint:
        "crawl:" + input.rule + ":" + findingKey(value),
      title: input.title,
      summary:
        urls.length +
        " crawled URLs share the same " +
        input.label +
        ": " +
        value,
      importance: urls.length >= 5 ? "medium" : "low",
      affectedScope: {
        urls: urls.slice(0, 50),
        value,
      },
      recommendedAction:
        "Check whether the URLs serve distinct search intents. Change metadata/content only where duplication reflects weak differentiation rather than intentional variants.",
      metadata: {
        rule: input.rule,
        url_count: urls.length,
      },
    });
  }

  return findings;
}

function brokenInternalLinkFindings(states: PageGraphState[]): CrawlFinding[] {
  const statusByUrl = new Map<string, number | null>();
  for (const state of states) {
    statusByUrl.set(state.requestedNormalized, state.page.statusCode);
    statusByUrl.set(state.finalNormalized, state.page.statusCode);
  }

  const grouped = new Map<
    string,
    { target: string; status: number; sources: Set<string> }
  >();

  for (const state of states) {
    for (const link of state.page.internalLinks) {
      const normalized = normalizeUrl(link.url);
      const status = statusByUrl.get(normalized);
      if (!status || status < 400) continue;

      const existing = grouped.get(normalized) || {
        target: link.url,
        status,
        sources: new Set<string>(),
      };
      existing.sources.add(state.page.requestedUrl);
      grouped.set(normalized, existing);
    }
  }

  return [...grouped.values()].slice(0, 150).map((item) => ({
    fingerprint: "crawl:broken-internal-link:" + findingKey(item.target),
    title: "Broken internal link target",
    summary:
      item.sources.size +
      " crawled page(s) link internally to " +
      item.target +
      ", which returned HTTP " +
      item.status +
      ".",
    importance: item.status >= 500 ? "high" : "medium",
    affectedScope: {
      target_url: item.target,
      status_code: item.status,
      source_urls: [...item.sources].slice(0, 50),
    },
    recommendedAction:
      "Update or remove internal references to the broken target, or restore/redirect the target when it should remain available.",
    metadata: {
      rule: "broken_internal_link",
      source_count: item.sources.size,
      status_code: item.status,
    },
  }));
}

function redirectInternalLinkFindings(states: PageGraphState[]): CrawlFinding[] {
  const redirectsByRequested = new Map<string, CrawledPage>();
  for (const state of states) {
    if (state.page.redirectChain.length) {
      redirectsByRequested.set(state.requestedNormalized, state.page);
    }
  }

  const grouped = new Map<
    string,
    { target: string; finalUrl: string; sources: Set<string> }
  >();

  for (const state of states) {
    for (const link of state.page.internalLinks) {
      const target = normalizeUrl(link.url);
      const redirected = redirectsByRequested.get(target);
      if (!redirected) continue;

      const existing = grouped.get(target) || {
        target: link.url,
        finalUrl: redirected.url,
        sources: new Set<string>(),
      };
      existing.sources.add(state.page.requestedUrl);
      grouped.set(target, existing);
    }
  }

  return [...grouped.values()].slice(0, 150).map((item) => ({
    fingerprint: "crawl:internal-link-redirect:" + findingKey(item.target),
    title: "Internal links point through a redirect",
    summary:
      item.sources.size +
      " crawled page(s) link to " +
      item.target +
      " instead of the final URL " +
      item.finalUrl +
      ".",
    importance: "low",
    affectedScope: {
      target_url: item.target,
      final_url: item.finalUrl,
      source_urls: [...item.sources].slice(0, 50),
    },
    recommendedAction:
      "Update internal links to point directly to the preferred final URL where practical.",
    metadata: {
      rule: "internal_link_redirect",
      source_count: item.sources.size,
    },
  }));
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

async function crawlWithDiscovery(input: {
  seedUrl: string;
  origin: string;
  sitemapUrls: string[];
  maxUrls: number;
}) {
  const home = new URL("/", input.origin).toString();
  const priorityQueue: string[] = [home];
  const sitemapQueue = input.sitemapUrls.filter(
    (url) => normalizeUrl(url) !== normalizeUrl(home),
  );
  const queued = new Set<string>([normalizeUrl(home)]);
  const requested = new Set<string>();
  const pages: CrawledPage[] = [];

  while (pages.length < input.maxUrls) {
    const batch: string[] = [];

    while (batch.length < 5 && pages.length + batch.length < input.maxUrls) {
      let candidate: string | undefined;

      while (priorityQueue.length && !candidate) {
        const next = priorityQueue.shift()!;
        const normalized = normalizeUrl(next);
        if (!requested.has(normalized)) candidate = next;
      }

      while (!candidate && sitemapQueue.length) {
        const next = sitemapQueue.shift()!;
        const normalized = normalizeUrl(next);
        if (!requested.has(normalized)) candidate = next;
      }

      if (!candidate) break;
      requested.add(normalizeUrl(candidate));
      batch.push(candidate);
    }

    if (!batch.length) break;

    const crawled = await mapLimit(batch, 5, (url) =>
      crawlPage(url, input.origin),
    );
    pages.push(...crawled);

    for (const page of crawled) {
      for (const link of page.internalLinks) {
        const normalized = normalizeUrl(link.url);
        if (requested.has(normalized) || queued.has(normalized)) continue;
        if (pages.length + priorityQueue.length >= input.maxUrls * 3) break;
        queued.add(normalized);
        priorityQueue.push(link.url);
      }
    }
  }

  return pages;
}

function buildGraphState(
  pages: CrawledPage[],
  sitemapUrls: string[],
  origin: string,
) {
  const sitemapSet = new Set(sitemapUrls.map(normalizeUrl));
  const states: PageGraphState[] = pages.map((page) => ({
    page,
    requestedNormalized: normalizeUrl(page.requestedUrl),
    finalNormalized: normalizeUrl(page.url),
    crawlDepth: null,
    inlinkCount: 0,
    sitemapPresent:
      sitemapSet.has(normalizeUrl(page.requestedUrl)) ||
      sitemapSet.has(normalizeUrl(page.url)),
    orphanCandidate: false,
  }));

  const crawledKeys = new Set<string>();
  for (const state of states) {
    crawledKeys.add(state.requestedNormalized);
    crawledKeys.add(state.finalNormalized);
  }

  const inlinks = new Map<string, Set<string>>();
  const adjacency = new Map<string, Set<string>>();

  for (const state of states) {
    const source = state.finalNormalized;
    const targets = adjacency.get(source) || new Set<string>();

    for (const link of state.page.internalLinks) {
      const target = normalizeUrl(link.url);
      if (!crawledKeys.has(target)) continue;

      targets.add(target);

      const sourceSet = inlinks.get(target) || new Set<string>();
      sourceSet.add(source);
      inlinks.set(target, sourceSet);
    }

    adjacency.set(source, targets);
  }

  const homeCandidates = [
    normalizeUrl(new URL("/", origin).toString()),
    ...states
      .filter((state) => new URL(state.page.url).pathname === "/")
      .map((state) => state.finalNormalized),
  ];

  const depth = new Map<string, number>();
  const queue: string[] = [];

  for (const home of homeCandidates) {
    if (!crawledKeys.has(home) || depth.has(home)) continue;
    depth.set(home, 0);
    queue.push(home);
  }

  while (queue.length) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current) || 0;

    for (const target of adjacency.get(current) || []) {
      if (depth.has(target)) continue;
      depth.set(target, currentDepth + 1);
      queue.push(target);
    }
  }

  for (const state of states) {
    const inlinkSources =
      inlinks.get(state.requestedNormalized) ||
      inlinks.get(state.finalNormalized) ||
      new Set<string>();

    state.inlinkCount = inlinkSources.size;
    state.crawlDepth =
      depth.get(state.requestedNormalized) ??
      depth.get(state.finalNormalized) ??
      null;

    const isHome = new URL(state.page.url).pathname === "/";
    state.orphanCandidate =
      !isHome &&
      state.sitemapPresent &&
      state.inlinkCount === 0 &&
      state.crawlDepth === null;
  }

  return states;
}

async function insertInChunks(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  chunkSize = 750,
) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
  }
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
    throw new Error(
      projectError?.message || "Project domain is required for crawling.",
    );
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
    const discovery = await discoverSitemapUrls(
      seedUrl,
      Math.min(maxUrls * 3, 1500),
    );

    const pages = await crawlWithDiscovery({
      seedUrl,
      origin: discovery.origin,
      sitemapUrls: discovery.sitemapUrls,
      maxUrls,
    });

    const states = buildGraphState(
      pages,
      discovery.sitemapUrls,
      discovery.origin,
    );

    const crawledTargetSet = new Set<string>();
    for (const state of states) {
      crawledTargetSet.add(state.requestedNormalized);
      crawledTargetSet.add(state.finalNormalized);
    }

    const pageRows = states.map((state) => ({
      crawl_run_id: run.id,
      project_id: input.projectId,
      owner_id: input.ownerId,
      requested_url: state.page.requestedUrl,
      url: state.page.requestedUrl,
      final_url: state.page.url,
      redirect_chain: state.page.redirectChain,
      status_code: state.page.statusCode,
      response_ms: state.page.responseMs,
      content_type: state.page.contentType,
      content_length_bytes: state.page.contentLengthBytes,
      title: state.page.title,
      meta_description: state.page.metaDescription,
      canonical: state.page.canonical,
      robots_meta: state.page.robotsMeta,
      x_robots_tag: state.page.xRobotsTag,
      html_lang: state.page.htmlLang,
      meta_refresh: state.page.metaRefresh,
      hreflangs: state.page.hreflangs,
      h1s: state.page.h1s,
      h2s: state.page.h2s,
      h3s: state.page.h3s,
      h4s: state.page.h4s,
      h5s: state.page.h5s,
      h6s: state.page.h6s,
      word_count: state.page.wordCount,
      internal_link_count: state.page.internalLinkCount,
      external_link_count: state.page.externalLinkCount,
      image_count: state.page.imageCount,
      missing_alt_count: state.page.missingAltCount,
      structured_data_count: state.page.structuredDataCount,
      invalid_structured_data_count: state.page.invalidStructuredDataCount,
      content_hash: state.page.contentHash,
      indexable: state.page.indexable,
      indexability_reason: state.page.indexabilityReason,
      crawl_depth: state.crawlDepth,
      inlink_count: state.inlinkCount,
      sitemap_present: state.sitemapPresent,
      orphan_candidate: state.orphanCandidate,
      fetch_error: state.page.fetchError,
      metadata: state.page.metadata,
    }));

    if (pageRows.length) {
      await insertInChunks(supabase, "crawl_pages", pageRows, 500);
    }

    const linkRows = states.flatMap((state) => [
      ...state.page.internalLinks.map((link) => ({
        crawl_run_id: run.id,
        project_id: input.projectId,
        owner_id: input.ownerId,
        source_url: state.page.url,
        target_url: link.url,
        link_scope: "internal",
        anchor_text: link.anchorText,
        rel: link.rel,
        nofollow: link.nofollow,
        target_crawled: crawledTargetSet.has(normalizeUrl(link.url)),
      })),
      ...state.page.externalLinks.map((link) => ({
        crawl_run_id: run.id,
        project_id: input.projectId,
        owner_id: input.ownerId,
        source_url: state.page.url,
        target_url: link.url,
        link_scope: "external",
        anchor_text: link.anchorText,
        rel: link.rel,
        nofollow: link.nofollow,
        target_crawled: false,
      })),
    ]).slice(0, 50000);

    if (linkRows.length) {
      await insertInChunks(supabase, "crawl_links", linkRows, 750);
    }

    const findings = [
      ...states.flatMap(pageFindings),
      ...groupedDuplicateFinding({
        pages: states,
        selector: (page) => page.title,
        rule: "duplicate_title",
        title: "Duplicate title across crawled pages",
        label: "title",
      }),
      ...groupedDuplicateFinding({
        pages: states,
        selector: (page) => page.metaDescription,
        rule: "duplicate_meta_description",
        title: "Duplicate meta description across crawled pages",
        label: "meta description",
      }),
      ...groupedDuplicateFinding({
        pages: states,
        selector: (page) => page.contentHash,
        rule: "duplicate_content_hash",
        title: "Duplicate HTML content detected",
        label: "HTML content hash",
      }),
      ...brokenInternalLinkFindings(states),
      ...redirectInternalLinkFindings(states),
    ].slice(0, 750);

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
            "This was detected from direct crawl evidence. Validate the affected template, intent and business importance before implementation.",
          importance: finding.importance,
          confidence: "high",
          status: "open",
          fingerprint: finding.fingerprint,
          affected_scope: finding.affectedScope,
          recommended_action: finding.recommendedAction,
          metadata: {
            source: "http_crawl",
            detector: "technical_rule_engine_v2",
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

    const errors = states.filter(
      (state) =>
        state.page.fetchError ||
        (state.page.statusCode && state.page.statusCode >= 400),
    ).length;
    const indexableCandidates = states.filter(
      (state) => state.page.indexable === true,
    ).length;
    const orphanCandidates = states.filter(
      (state) => state.orphanCandidate,
    ).length;
    const redirectedPages = states.filter(
      (state) => state.page.redirectChain.length > 0,
    ).length;
    const noindexPages = states.filter((state) =>
      [state.page.robotsMeta, state.page.xRobotsTag]
        .filter(Boolean)
        .join(",")
        .toLowerCase()
        .includes("noindex"),
    ).length;
    const maxDepth = states.reduce(
      (max, state) =>
        state.crawlDepth === null ? max : Math.max(max, state.crawlDepth),
      0,
    );

    const summary = {
      crawler_version: "raw-http-v2",
      sitemap_count: discovery.sitemapCount,
      sitemap_urls_discovered: discovery.sitemapUrls.length,
      sitemap_urls_not_crawled_in_sample: Math.max(
        discovery.sitemapUrls.length -
          states.filter((state) => state.sitemapPresent).length,
        0,
      ),
      pages_discovered: states.length,
      pages_crawled: states.length,
      internal_links_stored: linkRows.filter(
        (row) => row.link_scope === "internal",
      ).length,
      external_links_stored: linkRows.filter(
        (row) => row.link_scope === "external",
      ).length,
      fetch_or_http_errors: errors,
      indexable_candidates: indexableCandidates,
      noindex_pages: noindexPages,
      redirected_pages: redirectedPages,
      orphan_candidates: orphanCandidates,
      max_crawl_depth: maxDepth,
      finding_count: findings.length,
      avg_response_ms:
        states.filter((state) => state.page.responseMs).length
          ? Math.round(
              states.reduce(
                (sum, state) => sum + (state.page.responseMs || 0),
                0,
              ) /
                states.filter((state) => state.page.responseMs).length,
            )
          : null,
    };

    await supabase
      .from("crawl_runs")
      .update({
        status:
          errors === states.length && states.length ? "partial" : "succeeded",
        pages_discovered: states.length,
        pages_crawled: states.length,
        error_count: errors,
        summary,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    return { runId: run.id as string, summary };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Crawl failed.";
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
