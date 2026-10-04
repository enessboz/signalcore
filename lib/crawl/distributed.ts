import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  crawlPage,
  discoverSitemapUrls,
  type CrawledPage,
} from "@/lib/crawl/http-crawler";
import {
  fetchRobotsPolicy,
  isRobotsAllowed,
  type RobotsPolicy,
  type RobotsRule,
} from "@/lib/crawl/robots";
import {
  normalizeUrl,
  pageFindings,
  type CrawlFinding,
  type PageGraphState,
} from "@/lib/crawl/run-project-crawl";

type QueueSource = "seed" | "sitemap" | "link" | "redirect" | "manual";

type CrawlConfig = {
  batch_size?: number;
  min_delay_ms?: number;
  respect_robots?: boolean;
  js_render_mode?: "off" | "auto" | "always";
  pagespeed_enabled?: boolean;
  pagespeed_sample_size?: number;
};

type QueueRow = {
  id: string;
  url: string;
  normalized_url: string;
  depth: number;
  source: QueueSource;
  discovered_from: string | null;
  attempts: number;
  max_attempts: number;
  render_mode: "http" | "js";
};

type CrawlRunRow = {
  id: string;
  project_id: string;
  owner_id: string;
  seed_url: string;
  max_urls: number;
  crawl_type: "http" | "delta" | "prospect_audit";
  status: string;
  js_render_mode: "off" | "auto" | "always";
  robots_compliant: boolean;
  crawl_config: CrawlConfig | null;
  summary: Record<string, unknown> | null;
};

type BaselinePage = {
  requested_url: string | null;
  url: string;
  final_url: string | null;
  status_code: number | null;
  title: string | null;
  canonical: string | null;
  indexable: boolean | null;
  indexability_reason: string | null;
  content_hash: string | null;
};

type StoredPage = {
  id: string;
  requested_url: string | null;
  url: string;
  final_url: string | null;
  status_code: number | null;
  title: string | null;
  meta_description: string | null;
  canonical: string | null;
  robots_meta: string | null;
  x_robots_tag: string | null;
  indexable: boolean | null;
  indexability_reason: string | null;
  crawl_depth: number | null;
  inlink_count: number;
  sitemap_present: boolean;
  word_count: number;
  content_hash: string | null;
  content_simhash: string | null;
  fetch_error: string | null;
  response_ms: number | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCrawlableInternalUrl(raw: string, origin: string) {
  try {
    const url = new URL(raw);
    if (url.origin !== origin) return false;
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const lower = url.pathname.toLowerCase();
    if (
      /\.(?:jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|rar|7z|gz|mp4|mp3|avi|mov|wmv|woff2?|ttf|eot|css|js|xml|json)(?:$|\/)/i.test(
        lower,
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function queuePriority(source: QueueSource, depth: number) {
  if (source === "seed") return 100;
  if (source === "sitemap") return 80;
  return Math.max(20, 70 - depth * 5);
}

function robotsFromAudit(row: {
  robots_url: string;
  status_code: number | null;
  fetch_status: "succeeded" | "missing" | "failed";
  rules: unknown;
  sitemap_urls: unknown;
  crawl_delay_ms: number | null;
  blocks_all: boolean;
  error: string | null;
}): RobotsPolicy {
  const payload =
    row.rules && typeof row.rules === "object"
      ? (row.rules as {
          selected_agent?: string;
          rules?: RobotsRule[];
        })
      : {};
  return {
    robotsUrl: row.robots_url,
    statusCode: row.status_code,
    fetchStatus: row.fetch_status,
    selectedAgent: payload.selected_agent || "SignalCoreBot",
    rules: Array.isArray(payload.rules) ? payload.rules : [],
    sitemapUrls: Array.isArray(row.sitemap_urls)
      ? row.sitemap_urls.map(String)
      : [],
    crawlDelayMs: row.crawl_delay_ms,
    blocksAll: Boolean(row.blocks_all),
    contentHash: null,
    error: row.error,
  };
}

async function upsertFindings(
  client: SupabaseClient,
  input: {
    projectId: string;
    ownerId: string;
    runId: string;
    findings: CrawlFinding[];
    detector?: string;
  },
) {
  if (!input.findings.length) return 0;
  const now = new Date().toISOString();
  const rows = input.findings.slice(0, 1500).map((finding) => ({
    project_id: input.projectId,
    owner_id: input.ownerId,
    finding_type: finding.findingType || "issue",
    title: finding.title,
    summary: finding.summary,
    why_it_matters:
      "Detected from deterministic technical crawl evidence. Validate affected templates and business importance before implementation.",
    importance: finding.importance,
    confidence: "high",
    status: "open",
    fingerprint: finding.fingerprint,
    affected_scope: finding.affectedScope,
    recommended_action: finding.recommendedAction,
    metadata: {
      source: "distributed_http_crawl",
      detector: input.detector || "technical_rule_engine_v3",
      crawl_run_id: input.runId,
      ...finding.metadata,
    },
    last_seen_at: now,
    updated_at: now,
  }));

  for (let index = 0; index < rows.length; index += 300) {
    const { error } = await client.from("findings").upsert(
      rows.slice(index, index + 300),
      { onConflict: "project_id,fingerprint" },
    );
    if (error) throw new Error("Crawl finding upsert failed: " + error.message);
  }
  return rows.length;
}

async function queueRows(
  client: SupabaseClient,
  rows: Array<{
    crawl_run_id: string;
    project_id: string;
    owner_id: string;
    url: string;
    normalized_url: string;
    depth: number;
    source: QueueSource;
    discovered_from?: string | null;
    priority: number;
    robots_allowed?: boolean | null;
  }>,
) {
  if (!rows.length) return;
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await client.from("crawl_url_queue").upsert(
      rows.slice(index, index + 500),
      {
        onConflict: "crawl_run_id,normalized_url",
        ignoreDuplicates: true,
      },
    );
    if (error) throw new Error("Crawl frontier insert failed: " + error.message);
  }
}

export async function startQueuedCrawl(input: {
  client: SupabaseClient;
  ownerId: string;
  projectId: string;
  maxUrls: number;
  crawlType?: "http" | "delta";
  batchSize?: number;
  minDelayMs?: number;
  respectRobots?: boolean;
  jsRenderMode?: "off" | "auto" | "always";
  pagespeedEnabled?: boolean;
  pagespeedSampleSize?: number;
}) {
  const maxUrls = Math.min(Math.max(Number(input.maxUrls || 10_000), 1), 100_000);
  const batchSize = Math.min(Math.max(Number(input.batchSize || 50), 5), 100);
  const minDelayMs = Math.min(Math.max(Number(input.minDelayMs || 250), 0), 10_000);
  const respectRobots = input.respectRobots !== false;
  const jsRenderMode = input.jsRenderMode || "off";
  const pagespeedSampleSize = Math.min(
    Math.max(Number(input.pagespeedSampleSize || 20), 0),
    100,
  );

  const { data: existing } = await input.client
    .from("crawl_runs")
    .select("id,status")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .eq("execution_mode", "queue")
    .eq("status", "running")
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return {
      runId: existing.id as string,
      reused: true,
      queued: 0,
      status: "running",
    };
  }

  const { data: project, error: projectError } = await input.client
    .from("projects")
    .select("id,domain")
    .eq("id", input.projectId)
    .eq("owner_id", input.ownerId)
    .single();

  if (projectError || !project?.domain) {
    throw new Error(projectError?.message || "Project domain is required.");
  }

  const seedUrl = project.domain.startsWith("http")
    ? project.domain
    : "https://" + project.domain;
  const origin = new URL(seedUrl).origin;
  const robots = await fetchRobotsPolicy(origin);

  const crawlConfig: CrawlConfig = {
    batch_size: batchSize,
    min_delay_ms: minDelayMs,
    respect_robots: respectRobots,
    js_render_mode: jsRenderMode,
    pagespeed_enabled: Boolean(input.pagespeedEnabled),
    pagespeed_sample_size: pagespeedSampleSize,
  };

  const { data: run, error: runError } = await input.client
    .from("crawl_runs")
    .insert({
      project_id: input.projectId,
      owner_id: input.ownerId,
      crawl_type: input.crawlType || "http",
      status: "running",
      execution_mode: "queue",
      seed_url: seedUrl,
      max_urls: maxUrls,
      robots_compliant: respectRobots,
      js_render_mode: jsRenderMode,
      crawl_config: crawlConfig,
      queue_started_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      summary: {
        crawler_version: "distributed-http-v3",
        phase: "frontier_initialization",
      },
    })
    .select("id")
    .single();

  if (runError || !run) {
    throw new Error(runError?.message || "Queued crawl run could not be created.");
  }

  await input.client.from("crawl_robots_audits").insert({
    crawl_run_id: run.id,
    project_id: input.projectId,
    owner_id: input.ownerId,
    robots_url: robots.robotsUrl,
    status_code: robots.statusCode,
    fetch_status: robots.fetchStatus,
    content_hash: robots.contentHash,
    rules: {
      selected_agent: robots.selectedAgent,
      rules: robots.rules,
    },
    sitemap_urls: robots.sitemapUrls,
    crawl_delay_ms: robots.crawlDelayMs,
    blocks_all: robots.blocksAll,
    error: robots.error,
  });

  const robotsFindings: CrawlFinding[] = [];
  if (robots.fetchStatus === "failed" && respectRobots) {
    robotsFindings.push({
      fingerprint: "crawl:robots-unavailable:" + encodeURIComponent(origin),
      title: "robots.txt could not be safely evaluated",
      summary:
        "SignalCore paused crawling because robots.txt was temporarily unavailable: " +
        (robots.error || "unknown error"),
      importance: "high",
      affectedScope: { origin, robots_url: robots.robotsUrl },
      recommendedAction:
        "Restore a stable robots.txt response, then retry the crawl. SignalCore intentionally does not bypass an unavailable robots policy.",
      metadata: { rule: "robots_unavailable" },
    });

    await upsertFindings(input.client, {
      projectId: input.projectId,
      ownerId: input.ownerId,
      runId: run.id,
      findings: robotsFindings,
    });

    await input.client
      .from("crawl_runs")
      .update({
        status: "failed",
        error_count: 1,
        summary: {
          crawler_version: "distributed-http-v3",
          completion_reason: "robots_unavailable",
          robots: {
            fetch_status: robots.fetchStatus,
            error: robots.error,
          },
        },
        completed_at: new Date().toISOString(),
        queue_completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    return {
      runId: run.id as string,
      reused: false,
      queued: 0,
      status: "failed",
    };
  }

  if (robots.blocksAll && respectRobots) {
    robotsFindings.push({
      fingerprint: "crawl:robots-blocks-all:" + encodeURIComponent(origin),
      title: "robots.txt blocks the entire site for SignalCoreBot",
      summary:
        "The selected robots.txt group disallows the root path, so no page requests were made.",
      importance: "high",
      affectedScope: { origin, robots_url: robots.robotsUrl },
      recommendedAction:
        "Confirm whether the crawl block is intentional. Do not weaken robots rules solely for an audit unless the site owner explicitly approves it.",
      metadata: { rule: "robots_blocks_all" },
    });
  }

  const discovery = await discoverSitemapUrls(seedUrl, maxUrls);
  const candidates = [
    { url: new URL("/", origin).toString(), source: "seed" as const, depth: 0 },
    ...discovery.sitemapUrls.map((url) => ({
      url,
      source: "sitemap" as const,
      depth: 1,
    })),
  ];

  const dedupe = new Set<string>();
  const frontier: Array<{
    crawl_run_id: string;
    project_id: string;
    owner_id: string;
    url: string;
    normalized_url: string;
    depth: number;
    source: QueueSource;
    priority: number;
    robots_allowed: boolean;
  }> = [];
  let robotsBlockedSeeds = 0;

  for (const candidate of candidates) {
    if (frontier.length >= maxUrls) break;
    const normalized = normalizeUrl(candidate.url);
    if (!normalized || dedupe.has(normalized)) continue;
    dedupe.add(normalized);

    const allowed = !respectRobots || isRobotsAllowed(robots, candidate.url);
    if (!allowed) {
      robotsBlockedSeeds += 1;
      continue;
    }

    frontier.push({
      crawl_run_id: run.id,
      project_id: input.projectId,
      owner_id: input.ownerId,
      url: normalized,
      normalized_url: normalized,
      depth: candidate.depth,
      source: candidate.source,
      priority: queuePriority(candidate.source, candidate.depth),
      robots_allowed: true,
    });
  }

  if (robotsBlockedSeeds > 0) {
    robotsFindings.push({
      fingerprint: "crawl:robots-blocked-sitemap-urls:" + encodeURIComponent(origin),
      title: "Sitemap URLs are blocked by robots.txt",
      summary:
        robotsBlockedSeeds +
        " seed/sitemap URL(s) were excluded from the crawl because robots.txt disallows them.",
      importance: "medium",
      affectedScope: {
        origin,
        blocked_url_count: robotsBlockedSeeds,
      },
      recommendedAction:
        "Cross-check whether URLs intentionally listed in XML sitemaps should also be crawlable. Align sitemap and robots directives where they conflict with indexing intent.",
      metadata: {
        rule: "robots_sitemap_conflict",
        blocked_url_count: robotsBlockedSeeds,
      },
    });
  }

  await upsertFindings(input.client, {
    projectId: input.projectId,
    ownerId: input.ownerId,
    runId: run.id,
    findings: robotsFindings,
  });

  await queueRows(input.client, frontier);

  await input.client
    .from("crawl_runs")
    .update({
      pages_discovered: frontier.length,
      summary: {
        crawler_version: "distributed-http-v3",
        phase: "queued",
        execution_mode: "queue",
        sitemap_count: discovery.sitemapCount,
        sitemap_scan_exhausted: discovery.scanExhausted,
        sitemap_urls_discovered: discovery.sitemapUrls.length,
        initial_frontier: frontier.length,
        robots_blocked_seeds: robotsBlockedSeeds,
        robots: {
          fetch_status: robots.fetchStatus,
          status_code: robots.statusCode,
          selected_agent: robots.selectedAgent,
          crawl_delay_ms: robots.crawlDelayMs,
          blocks_all: robots.blocksAll,
        },
      },
    })
    .eq("id", run.id);

  if (!frontier.length) {
    await input.client
      .from("crawl_runs")
      .update({
        status: "partial",
        summary: {
          crawler_version: "distributed-http-v3",
          completion_reason: robots.blocksAll
            ? "robots_blocks_all"
            : "empty_frontier",
          robots_blocked_seeds: robotsBlockedSeeds,
        },
        completed_at: new Date().toISOString(),
        queue_completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
  }

  return {
    runId: run.id as string,
    reused: false,
    queued: frontier.length,
    status: frontier.length ? "running" : "partial",
  };
}

function pageRow(input: {
  run: CrawlRunRow;
  queue: QueueRow;
  page: CrawledPage;
}) {
  return {
    crawl_run_id: input.run.id,
    project_id: input.run.project_id,
    owner_id: input.run.owner_id,
    requested_url: normalizeUrl(input.page.requestedUrl),
    url: normalizeUrl(input.page.requestedUrl),
    final_url: normalizeUrl(input.page.url),
    redirect_chain: input.page.redirectChain,
    status_code: input.page.statusCode,
    response_ms: input.page.responseMs,
    content_type: input.page.contentType,
    content_length_bytes: input.page.contentLengthBytes,
    title: input.page.title,
    meta_description: input.page.metaDescription,
    canonical: input.page.canonical,
    robots_meta: input.page.robotsMeta,
    x_robots_tag: input.page.xRobotsTag,
    html_lang: input.page.htmlLang,
    meta_refresh: input.page.metaRefresh,
    hreflangs: input.page.hreflangs,
    h1s: input.page.h1s,
    h2s: input.page.h2s,
    h3s: input.page.h3s,
    h4s: input.page.h4s,
    h5s: input.page.h5s,
    h6s: input.page.h6s,
    word_count: input.page.wordCount,
    internal_link_count: input.page.internalLinkCount,
    external_link_count: input.page.externalLinkCount,
    image_count: input.page.imageCount,
    missing_alt_count: input.page.missingAltCount,
    structured_data_count: input.page.structuredDataCount,
    invalid_structured_data_count: input.page.invalidStructuredDataCount,
    content_hash: input.page.contentHash,
    content_simhash: input.page.contentSimhash,
    indexable: input.page.indexable,
    indexability_reason: input.page.indexabilityReason,
    crawl_depth: input.queue.depth,
    inlink_count: 0,
    sitemap_present: input.queue.source === "sitemap",
    orphan_candidate: false,
    rendered: input.page.rendered,
    render_reason: input.page.renderReason,
    fetch_error: input.page.fetchError,
    metadata: {
      ...input.page.metadata,
      queue_source: input.queue.source,
      discovered_from: input.queue.discovered_from,
      queue_attempt: input.queue.attempts,
    },
  };
}

function hammingDistance64(left: string, right: string) {
  try {
    let xor = BigInt("0x" + left) ^ BigInt("0x" + right);
    let count = 0;
    while (xor) {
      count += Number(xor & 1n);
      xor >>= 1n;
    }
    return count;
  } catch {
    return 64;
  }
}

function nearDuplicateGroups(pages: StoredPage[]) {
  const buckets = new Map<string, StoredPage[]>();
  for (const page of pages) {
    if (
      !page.content_simhash ||
      page.status_code !== 200 ||
      page.word_count < 80
    ) {
      continue;
    }
    const bucket = page.content_simhash.slice(0, 3);
    const list = buckets.get(bucket) || [];
    list.push(page);
    buckets.set(bucket, list);
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const list of buckets.values()) {
    const bounded = list.slice(0, 300);
    for (let i = 0; i < bounded.length; i += 1) {
      const a = bounded[i]!;
      parent.set(a.id, parent.get(a.id) || a.id);
      for (let j = i + 1; j < bounded.length; j += 1) {
        const b = bounded[j]!;
        const ratio =
          Math.min(a.word_count, b.word_count) /
          Math.max(a.word_count, b.word_count);
        if (ratio < 0.8) continue;
        if (
          a.content_simhash &&
          b.content_simhash &&
          hammingDistance64(a.content_simhash, b.content_simhash) <= 5
        ) {
          union(a.id, b.id);
        }
      }
    }
  }

  const grouped = new Map<string, StoredPage[]>();
  for (const page of pages) {
    if (!parent.has(page.id)) continue;
    const root = find(page.id);
    const list = grouped.get(root) || [];
    list.push(page);
    grouped.set(root, list);
  }

  return [...grouped.values()].filter((group) => group.length >= 2);
}

async function loadQueueRows(client: SupabaseClient, runId: string) {
  const rows: Array<{
    normalized_url: string;
    source: string;
    status: string;
    robots_allowed: boolean | null;
  }> = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await client
      .from("crawl_url_queue")
      .select("normalized_url,source,status,robots_allowed")
      .eq("crawl_run_id", runId)
      .range(from, from + 999);
    if (error) throw new Error("Crawl queue could not be finalized: " + error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function loadBaselinePages(
  client: SupabaseClient,
  input: {
    projectId: string;
    ownerId: string;
    currentRunId: string;
  },
) {
  const { data: baselineRun, error: baselineError } = await client
    .from("crawl_runs")
    .select("id")
    .eq("project_id", input.projectId)
    .eq("owner_id", input.ownerId)
    .in("status", ["succeeded", "partial"])
    .neq("id", input.currentRunId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (baselineError) {
    throw new Error("Delta baseline could not be resolved: " + baselineError.message);
  }
  if (!baselineRun?.id) {
    return { baselineRunId: null as string | null, pages: [] as BaselinePage[] };
  }

  const pages: BaselinePage[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await client
      .from("crawl_pages")
      .select("requested_url,url,final_url,status_code,title,canonical,indexable,indexability_reason,content_hash")
      .eq("crawl_run_id", baselineRun.id)
      .range(from, from + 999);
    if (error) {
      throw new Error("Delta baseline pages could not be loaded: " + error.message);
    }
    pages.push(...((data || []) as BaselinePage[]));
    if (!data || data.length < 1000) break;
  }

  return { baselineRunId: baselineRun.id as string, pages };
}

function distributedDeltaFindings(
  current: StoredPage[],
  baseline: BaselinePage[],
) {
  const baselineByUrl = new Map<string, BaselinePage>();
  for (const page of baseline) {
    baselineByUrl.set(normalizeUrl(page.requested_url || page.url), page);
  }

  const findings: CrawlFinding[] = [];
  let compared = 0;
  let newUrls = 0;
  let contentChanges = 0;
  let statusChanges = 0;
  let titleChanges = 0;
  let canonicalChanges = 0;
  let indexabilityChanges = 0;

  for (const page of current) {
    const url = normalizeUrl(page.requested_url || page.url);
    const previous = baselineByUrl.get(url);
    if (!previous) {
      newUrls += 1;
      continue;
    }
    compared += 1;

    if (
      previous.content_hash &&
      page.content_hash &&
      previous.content_hash !== page.content_hash
    ) {
      contentChanges += 1;
    }

    if (previous.status_code !== page.status_code) {
      statusChanges += 1;
      if (
        previous.status_code !== null &&
        previous.status_code < 400 &&
        page.status_code !== null &&
        page.status_code >= 400
      ) {
        findings.push({
          fingerprint: "crawl:regression-status:" + encodeURIComponent(url).slice(0, 400),
          findingType: "regression",
          title: "HTTP status regression",
          summary:
            url +
            " changed from HTTP " +
            previous.status_code +
            " to HTTP " +
            page.status_code +
            ".",
          importance: page.status_code >= 500 ? "high" : "medium",
          affectedScope: {
            url,
            previous_status: previous.status_code,
            current_status: page.status_code,
          },
          recommendedAction:
            "Investigate the deployment, routing or redirect change that caused this previously successful URL to return an error.",
          metadata: {
            rule: "delta_status_regression",
            previous_status: previous.status_code,
            current_status: page.status_code,
          },
        });
      }
    }

    if ((previous.title || null) !== (page.title || null)) {
      titleChanges += 1;
      if (previous.title && !page.title) {
        findings.push({
          fingerprint: "crawl:regression-title-missing:" + encodeURIComponent(url).slice(0, 400),
          findingType: "regression",
          title: "Title disappeared since previous crawl",
          summary:
            url +
            " had a title in the baseline crawl but no title is present now.",
          importance: "medium",
          affectedScope: {
            url,
            previous_title: previous.title,
          },
          recommendedAction:
            "Review recent template or deployment changes that removed the title element.",
          metadata: { rule: "delta_title_removed" },
        });
      }
    }

    if ((previous.canonical || null) !== (page.canonical || null)) {
      canonicalChanges += 1;
    }

    if (previous.indexable !== page.indexable) {
      indexabilityChanges += 1;
      if (previous.indexable === true && page.indexable === false) {
        findings.push({
          fingerprint: "crawl:regression-indexability:" + encodeURIComponent(url).slice(0, 400),
          findingType: "regression",
          title: "Indexability regression",
          summary:
            url +
            " changed from an indexable candidate to non-indexable (" +
            String(page.indexability_reason || "unknown reason") +
            ").",
          importance: "high",
          affectedScope: {
            url,
            previous_indexable: true,
            current_indexable: false,
            previous_reason: previous.indexability_reason,
            current_reason: page.indexability_reason,
          },
          recommendedAction:
            "Validate whether this change is intentional. Review status, robots directives and canonical behavior before considering the deployment healthy.",
          metadata: {
            rule: "delta_indexability_regression",
            previous_reason: previous.indexability_reason,
            current_reason: page.indexability_reason,
          },
        });
      }
    }
  }

  return {
    findings,
    summary: {
      compared_urls: compared,
      new_urls: newUrls,
      content_changes: contentChanges,
      status_changes: statusChanges,
      title_changes: titleChanges,
      canonical_changes: canonicalChanges,
      indexability_changes: indexabilityChanges,
      changed_urls:
        contentChanges +
        statusChanges +
        titleChanges +
        canonicalChanges +
        indexabilityChanges,
    },
  };
}

async function loadRunPages(client: SupabaseClient, runId: string) {
  const pages: StoredPage[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await client
      .from("crawl_pages")
      .select("id,requested_url,url,final_url,status_code,title,meta_description,canonical,robots_meta,x_robots_tag,indexable,indexability_reason,crawl_depth,inlink_count,sitemap_present,word_count,content_hash,content_simhash,fetch_error,response_ms")
      .eq("crawl_run_id", runId)
      .range(from, from + 999);
    if (error) throw new Error("Crawl pages could not be finalized: " + error.message);
    pages.push(...((data || []) as StoredPage[]));
    if (!data || data.length < 1000) break;
  }
  return pages;
}

function exactDuplicateFindings(
  pages: StoredPage[],
  field: "title" | "meta_description" | "content_hash",
  label: string,
): CrawlFinding[] {
  const groups = new Map<string, StoredPage[]>();
  for (const page of pages) {
    if (page.status_code !== 200) continue;
    const value = page[field]?.trim().toLowerCase();
    if (!value) continue;
    const list = groups.get(value) || [];
    list.push(page);
    groups.set(value, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .slice(0, 200)
    .map(([value, list]) => ({
      fingerprint:
        "crawl:distributed-duplicate:" +
        field +
        ":" +
        encodeURIComponent(value).slice(0, 300),
      title: "Duplicate " + label + " across crawled pages",
      summary:
        list.length +
        " URLs share the same " +
        label +
        (field === "content_hash" ? "." : ": " + value),
      importance: list.length >= 5 ? "medium" : "low",
      affectedScope: {
        urls: list.slice(0, 50).map((page) => page.requested_url || page.url),
        value: field === "content_hash" ? undefined : value,
      },
      recommendedAction:
        "Review whether these URLs serve distinct search intents. Consolidate or differentiate only where duplication is not intentional.",
      metadata: {
        rule: "distributed_duplicate_" + field,
        url_count: list.length,
      },
    }));
}

async function finalizeQueuedCrawl(
  client: SupabaseClient,
  run: CrawlRunRow,
) {
  const pages = await loadRunPages(client, run.id);
  const queueRowsAll = await loadQueueRows(client, run.id);

  const { data: graphSummary, error: graphError } = await client.rpc(
    "finalize_distributed_crawl_graph",
    { p_run_id: run.id },
  );
  if (graphError) {
    throw new Error("Distributed crawl graph finalization failed: " + graphError.message);
  }
  const sitemapSet = new Set(
    queueRowsAll
      .filter((row) => row.source === "sitemap")
      .map((row) => row.normalized_url),
  );

  let deltaSummary: Record<string, unknown> | null = null;
  let deltaFindings: CrawlFinding[] = [];
  if (run.crawl_type === "delta") {
    const baseline = await loadBaselinePages(client, {
      projectId: run.project_id,
      ownerId: run.owner_id,
      currentRunId: run.id,
    });
    if (baseline.baselineRunId) {
      const delta = distributedDeltaFindings(pages, baseline.pages);
      deltaFindings = delta.findings;
      deltaSummary = {
        baseline_run_id: baseline.baselineRunId,
        ...delta.summary,
      };
    } else {
      deltaSummary = {
        baseline_run_id: null,
        compared_urls: 0,
        new_urls: pages.length,
        content_changes: 0,
        status_changes: 0,
        title_changes: 0,
        canonical_changes: 0,
        indexability_changes: 0,
        changed_urls: pages.length,
      };
    }
  }

  const aggregate: CrawlFinding[] = [
    ...deltaFindings,
    ...exactDuplicateFindings(pages, "title", "title"),
    ...exactDuplicateFindings(pages, "meta_description", "meta description"),
    ...exactDuplicateFindings(pages, "content_hash", "content"),
  ];

  const nearGroups = nearDuplicateGroups(pages);
  for (let index = 0; index < nearGroups.length; index += 1) {
    const group = nearGroups[index]!;
    const groupKey = run.id.slice(0, 8) + "-nd-" + String(index + 1);
    for (let offset = 0; offset < group.length; offset += 100) {
      const ids = group.slice(offset, offset + 100).map((page) => page.id);
      const { error } = await client
        .from("crawl_pages")
        .update({ near_duplicate_group: groupKey })
        .in("id", ids);
      if (error) throw new Error("Near-duplicate group update failed: " + error.message);
    }

    aggregate.push({
      fingerprint: "crawl:near-duplicate:" + run.id + ":" + groupKey,
      title: "Near-duplicate content cluster detected",
      summary:
        group.length +
        " crawled pages have highly similar text fingerprints (SimHash distance ≤ 5).",
      importance: group.length >= 5 ? "medium" : "low",
      affectedScope: {
        group: groupKey,
        urls: group.slice(0, 50).map((page) => page.requested_url || page.url),
      },
      recommendedAction:
        "Review whether these pages represent intentional variants. Consolidate, canonicalize or differentiate only after checking search intent and template purpose.",
      metadata: {
        rule: "near_duplicate_simhash",
        group: groupKey,
        url_count: group.length,
      },
    });
  }

  const sitemapIssues = pages.filter(
    (page) =>
      page.sitemap_present &&
      (page.status_code !== 200 ||
        page.indexability_reason === "noindex" ||
        page.indexability_reason === "canonicalized"),
  );
  if (sitemapIssues.length) {
    aggregate.push({
      fingerprint: "crawl:sitemap-indexability-conflict:" + run.id,
      title: "XML sitemap contains non-indexable or non-success URLs",
      summary:
        sitemapIssues.length +
        " crawled sitemap URL(s) are non-200, noindex or canonicalized elsewhere.",
      importance: "medium",
      affectedScope: {
        urls: sitemapIssues
          .slice(0, 100)
          .map((page) => ({
            url: page.requested_url || page.url,
            status: page.status_code,
            indexability_reason: page.indexability_reason,
          })),
      },
      recommendedAction:
        "Keep XML sitemaps focused on canonical, successful, indexable URLs and remove entries that conflict with indexability intent.",
      metadata: {
        rule: "sitemap_indexability_conflict",
        url_count: sitemapIssues.length,
      },
    });
  }

  const scanExhausted = Boolean(
    (run.summary || {}).sitemap_scan_exhausted,
  );
  if (scanExhausted && sitemapSet.size) {
    const indexableMissing = pages.filter(
      (page) =>
        page.indexable === true &&
        !sitemapSet.has(normalizeUrl(page.requested_url || page.url)),
    );
    if (indexableMissing.length) {
      aggregate.push({
        fingerprint: "crawl:indexable-not-in-sitemap:" + run.id,
        title: "Indexable crawled URLs are absent from XML sitemaps",
        summary:
          indexableMissing.length +
          " indexable candidate URL(s) were discovered through internal links but not through the completed sitemap scan.",
        importance: "low",
        affectedScope: {
          urls: indexableMissing
            .slice(0, 100)
            .map((page) => page.requested_url || page.url),
        },
        recommendedAction:
          "Review whether these URLs belong in XML sitemaps. Add only canonical indexable URLs that are intentionally part of organic search inventory.",
        metadata: {
          rule: "indexable_not_in_sitemap",
          url_count: indexableMissing.length,
        },
      });
    }
  }

  await upsertFindings(client, {
    projectId: run.project_id,
    ownerId: run.owner_id,
    runId: run.id,
    findings: aggregate,
  });

  const failed = queueRowsAll.filter((row) => row.status === "failed").length;
  const skipped = queueRowsAll.filter((row) => row.status === "skipped").length;
  const succeeded = queueRowsAll.filter((row) => row.status === "succeeded").length;
  const errors = pages.filter(
    (page) =>
      Boolean(page.fetch_error) ||
      (page.status_code !== null && page.status_code >= 400),
  ).length;
  const avgResponse =
    pages.filter((page) => page.response_ms !== null).length > 0
      ? Math.round(
          pages.reduce((sum, page) => sum + Number(page.response_ms || 0), 0) /
            pages.filter((page) => page.response_ms !== null).length,
        )
      : null;

  const config = run.crawl_config || {};
  if (config.pagespeed_enabled && Number(config.pagespeed_sample_size || 0) > 0) {
    const sample = pages
      .filter((page) => page.status_code === 200 && page.indexable === true)
      .sort(
        (a, b) =>
          Number(a.crawl_depth ?? 999) - Number(b.crawl_depth ?? 999) ||
          Number(b.inlink_count || 0) - Number(a.inlink_count || 0),
      )
      .slice(0, Number(config.pagespeed_sample_size || 20));

    if (sample.length) {
      const { error } = await client.from("crawl_performance_queue").upsert(
        sample.map((page) => ({
          crawl_run_id: run.id,
          project_id: run.project_id,
          owner_id: run.owner_id,
          url: page.final_url || page.requested_url || page.url,
          strategy: "mobile",
          status: "queued",
        })),
        {
          onConflict: "crawl_run_id,url,strategy",
          ignoreDuplicates: true,
        },
      );
      if (error) throw new Error("PageSpeed sample queue failed: " + error.message);
    }
  }

  const previousSummary = run.summary || {};
  const summary = {
    ...previousSummary,
    crawler_version: "distributed-http-v3",
    phase: "complete",
    completion_reason: "frontier_exhausted",
    pages_discovered: queueRowsAll.length,
    pages_crawled: pages.length,
    queue_succeeded: succeeded,
    queue_failed: failed,
    queue_skipped: skipped,
    fetch_or_http_errors: errors,
    indexable_candidates: pages.filter((page) => page.indexable === true).length,
    sitemap_pages: pages.filter((page) => page.sitemap_present).length,
    near_duplicate_groups: nearGroups.length,
    finding_count_added_at_finalize: aggregate.length,
    avg_response_ms: avgResponse,
    delta: deltaSummary,
    max_crawl_depth:
      graphSummary && typeof graphSummary === "object"
        ? Number((graphSummary as { max_depth?: number }).max_depth || 0)
        : 0,
  };

  await client
    .from("crawl_runs")
    .update({
      status: failed > 0 ? "partial" : "succeeded",
      pages_discovered: queueRowsAll.length,
      pages_crawled: pages.length,
      error_count: errors + failed,
      summary,
      queue_completed_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  return summary;
}

export async function processQueuedCrawlBatch(input: {
  client: SupabaseClient;
  runId: string;
  deadlineAt?: number;
}) {
  const { data: runData, error: runError } = await input.client
    .from("crawl_runs")
    .select("id,project_id,owner_id,seed_url,max_urls,crawl_type,status,js_render_mode,robots_compliant,crawl_config,summary")
    .eq("id", input.runId)
    .eq("execution_mode", "queue")
    .single();

  if (runError || !runData) {
    throw new Error(runError?.message || "Queued crawl run not found.");
  }
  const run = runData as CrawlRunRow;
  if (run.status !== "running") {
    return {
      runId: run.id,
      processed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      newUrls: 0,
      queuedRemaining: 0,
      claimedRemaining: 0,
      complete: true,
      finalSummary: (run.summary || null) as Record<string, unknown> | null,
      status: run.status,
    };
  }

  const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await input.client
    .from("crawl_url_queue")
    .update({
      status: "failed",
      last_error: "Recovered stale claimed URL after maximum attempts.",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("crawl_run_id", run.id)
    .eq("status", "claimed")
    .gte("attempts", 3)
    .lt("claimed_at", staleCutoff);

  await input.client
    .from("crawl_url_queue")
    .update({
      status: "queued",
      claim_token: null,
      claimed_at: null,
      last_error: "Recovered stale claimed URL after interrupted worker.",
      available_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("crawl_run_id", run.id)
    .eq("status", "claimed")
    .lt("attempts", 3)
    .lt("claimed_at", staleCutoff);

  const config = run.crawl_config || {};
  const batchSize = Math.min(Math.max(Number(config.batch_size || 50), 5), 100);
  const claimToken = randomUUID();
  const { data: claimed, error: claimError } = await input.client.rpc(
    "claim_crawl_url_batch",
    {
      p_run_id: run.id,
      p_batch_size: batchSize,
      p_claim_token: claimToken,
    },
  );

  if (claimError) {
    throw new Error("Crawl frontier claim failed: " + claimError.message);
  }

  const batch = (claimed || []) as QueueRow[];

  const { data: robotsAudit, error: robotsError } = await input.client
    .from("crawl_robots_audits")
    .select("robots_url,status_code,fetch_status,rules,sitemap_urls,crawl_delay_ms,blocks_all,error")
    .eq("crawl_run_id", run.id)
    .single();

  if (robotsError || !robotsAudit) {
    throw new Error(robotsError?.message || "Robots audit missing for queued crawl.");
  }
  const robots = robotsFromAudit(robotsAudit);
  const origin = new URL(run.seed_url).origin;
  const respectRobots = config.respect_robots !== false;
  const delayMs = Math.max(
    Number(config.min_delay_ms || 0),
    Number(robots.crawlDelayMs || 0),
  );

  let lastRequestStartedAt = 0;
  let processed = 0;
  let succeeded = 0;
  let retried = 0;
  let failed = 0;
  let skipped = 0;
  let newUrls = 0;

  const { count: queueCountInitial } = await input.client
    .from("crawl_url_queue")
    .select("id", { count: "exact", head: true })
    .eq("crawl_run_id", run.id);
  let knownQueueCount = Number(queueCountInitial || 0);

  for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
    const item = batch[itemIndex]!;
    const safetyMs = Math.max(delayMs + 15_000, 20_000);
    if (input.deadlineAt && Date.now() + safetyMs >= input.deadlineAt) {
      const remainingIds = batch.slice(itemIndex).map((row) => row.id);
      if (remainingIds.length) {
        await input.client
          .from("crawl_url_queue")
          .update({
            status: "queued",
            claim_token: null,
            claimed_at: null,
            available_at: new Date().toISOString(),
            last_error: "Released before worker runtime deadline.",
            updated_at: new Date().toISOString(),
          })
          .eq("crawl_run_id", run.id)
          .eq("claim_token", claimToken)
          .in("id", remainingIds);
      }
      break;
    }

    processed += 1;

    const allowed = !respectRobots || isRobotsAllowed(robots, item.url);
    if (!allowed) {
      await input.client
        .from("crawl_url_queue")
        .update({
          status: "skipped",
          robots_allowed: false,
          last_error: "Blocked by robots.txt.",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id)
        .eq("claim_token", claimToken);
      skipped += 1;
      continue;
    }

    const waitFor = delayMs - (Date.now() - lastRequestStartedAt);
    if (lastRequestStartedAt && waitFor > 0) await sleep(waitFor);
    lastRequestStartedAt = Date.now();

    const page = await crawlPage(item.url, origin, {
      jsRenderMode: config.js_render_mode || run.js_render_mode || "off",
    });

    if (page.fetchError) {
      const canRetry = item.attempts < item.max_attempts;
      const backoffMs = Math.min(30_000 * 2 ** Math.max(item.attempts - 1, 0), 15 * 60_000);
      await input.client
        .from("crawl_url_queue")
        .update({
          status: canRetry ? "queued" : "failed",
          claim_token: null,
          claimed_at: null,
          robots_allowed: true,
          last_error: page.fetchError,
          available_at: canRetry
            ? new Date(Date.now() + backoffMs).toISOString()
            : new Date().toISOString(),
          completed_at: canRetry ? null : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id)
        .eq("claim_token", claimToken);

      if (canRetry) retried += 1;
      else failed += 1;
      continue;
    }

    const { error: pageError } = await input.client
      .from("crawl_pages")
      .insert(pageRow({ run, queue: item, page }));
    if (pageError) {
      await input.client
        .from("crawl_url_queue")
        .update({
          status: "failed",
          last_error: "Page persistence failed: " + pageError.message,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id)
        .eq("claim_token", claimToken);
      failed += 1;
      continue;
    }

    const links = [
      ...page.internalLinks.slice(0, 500).map((link) => ({
        crawl_run_id: run.id,
        project_id: run.project_id,
        owner_id: run.owner_id,
        source_url: normalizeUrl(page.url),
        target_url: normalizeUrl(link.url),
        link_scope: "internal",
        anchor_text: link.anchorText,
        rel: link.rel,
        nofollow: link.nofollow,
        target_crawled: false,
      })),
      ...page.externalLinks.slice(0, 50).map((link) => ({
        crawl_run_id: run.id,
        project_id: run.project_id,
        owner_id: run.owner_id,
        source_url: normalizeUrl(page.url),
        target_url: normalizeUrl(link.url),
        link_scope: "external",
        anchor_text: link.anchorText,
        rel: link.rel,
        nofollow: link.nofollow,
        target_crawled: false,
      })),
    ];
    if (links.length) {
      for (let index = 0; index < links.length; index += 500) {
        const { error } = await input.client
          .from("crawl_links")
          .insert(links.slice(index, index + 500));
        if (error) {
          throw new Error("Crawl link persistence failed: " + error.message);
        }
      }
    }

    const state: PageGraphState = {
      page,
      requestedNormalized: normalizeUrl(page.requestedUrl),
      finalNormalized: normalizeUrl(page.url),
      crawlDepth: item.depth,
      inlinkCount: 0,
      sitemapPresent: item.source === "sitemap",
      orphanCandidate: false,
    };
    await upsertFindings(input.client, {
      projectId: run.project_id,
      ownerId: run.owner_id,
      runId: run.id,
      findings: pageFindings(state),
    });

    const remaining = Math.max(run.max_urls - knownQueueCount, 0);
    if (remaining > 0) {
      const frontier: Array<{
        crawl_run_id: string;
        project_id: string;
        owner_id: string;
        url: string;
        normalized_url: string;
        depth: number;
        source: QueueSource;
        discovered_from: string;
        priority: number;
        robots_allowed: boolean;
      }> = [];
      const seen = new Set<string>();

      for (const link of page.internalLinks) {
        if (frontier.length >= remaining) break;
        if (!isCrawlableInternalUrl(link.url, origin)) continue;
        const normalized = normalizeUrl(link.url);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        const robotsAllowed =
          !respectRobots || isRobotsAllowed(robots, link.url);
        if (!robotsAllowed) continue;

        frontier.push({
          crawl_run_id: run.id,
          project_id: run.project_id,
          owner_id: run.owner_id,
          url: normalized,
          normalized_url: normalized,
          depth: Math.min(item.depth + 1, 1000),
          source: "link",
          discovered_from: page.url,
          priority: queuePriority("link", item.depth + 1),
          robots_allowed: true,
        });
      }

      if (frontier.length) {
        const before = knownQueueCount;
        await queueRows(input.client, frontier);
        const { count: newCount } = await input.client
          .from("crawl_url_queue")
          .select("id", { count: "exact", head: true })
          .eq("crawl_run_id", run.id);
        knownQueueCount = Number(newCount || knownQueueCount);
        newUrls += Math.max(knownQueueCount - before, 0);
      }
    }

    await input.client
      .from("crawl_url_queue")
      .update({
        status: "succeeded",
        robots_allowed: true,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id)
      .eq("claim_token", claimToken);
    succeeded += 1;
  }

  const [{ count: queuedCount }, { count: claimedCount }, { count: totalCount }, { count: pageCount }] =
    await Promise.all([
      input.client
        .from("crawl_url_queue")
        .select("id", { count: "exact", head: true })
        .eq("crawl_run_id", run.id)
        .eq("status", "queued"),
      input.client
        .from("crawl_url_queue")
        .select("id", { count: "exact", head: true })
        .eq("crawl_run_id", run.id)
        .eq("status", "claimed"),
      input.client
        .from("crawl_url_queue")
        .select("id", { count: "exact", head: true })
        .eq("crawl_run_id", run.id),
      input.client
        .from("crawl_pages")
        .select("id", { count: "exact", head: true })
        .eq("crawl_run_id", run.id),
    ]);

  await input.client
    .from("crawl_runs")
    .update({
      pages_discovered: totalCount || 0,
      pages_crawled: pageCount || 0,
      summary: {
        ...(run.summary || {}),
        phase: "crawling",
        frontier_total: totalCount || 0,
        frontier_queued: queuedCount || 0,
        frontier_claimed: claimedCount || 0,
        pages_crawled: pageCount || 0,
        last_batch: {
          processed,
          succeeded,
          retried,
          failed,
          skipped,
          new_urls: newUrls,
        },
      },
    })
    .eq("id", run.id);

  const complete =
    Number(queuedCount || 0) === 0 && Number(claimedCount || 0) === 0;

  let finalSummary: Record<string, unknown> | null = null;
  if (complete) {
    finalSummary = await finalizeQueuedCrawl(input.client, {
      ...run,
      summary: {
        ...(run.summary || {}),
        sitemap_scan_exhausted:
          (run.summary || {}).sitemap_scan_exhausted ?? false,
      },
    });
  }

  return {
    runId: run.id,
    processed,
    succeeded,
    retried,
    failed,
    skipped,
    newUrls,
    queuedRemaining: queuedCount || 0,
    claimedRemaining: claimedCount || 0,
    complete,
    finalSummary,
  };
}
