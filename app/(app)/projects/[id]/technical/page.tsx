
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { createClient } from "@/lib/supabase/server";
import { scheduleDescription, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import { getLocale } from "@/lib/i18n";
import {
  reviewCrawlFinding,
  runTechnicalCrawl,
  saveTechnicalCrawlSchedule,
  setTechnicalCrawlScheduleStatus,
} from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

type CrawlBenchmark = {
  run_id: string;
  status: string;
  execution_mode: string;
  max_urls: number;
  pages_discovered: number;
  pages_crawled: number;
  error_count: number;
  duration_ms: number | null;
  pages_per_minute: number | null;
  page_rows: number;
  page_bytes: number;
  link_rows: number;
  link_bytes: number;
  estimated_run_bytes: number;
  rendered_pages: number;
  performance_samples: number;
  finding_count: number;
  reviewed_findings: number;
  confirmed_findings: number;
  false_positive_findings: number;
  needs_context_findings: number;
  false_positive_ratio: number | null;
};

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function yesNo(value: boolean | null | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
}

function formatBytes(value: number | null | undefined) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatDuration(value: number | null | undefined) {
  const ms = Number(value || 0);
  if (!ms) return "—";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  if (ms < 3_600_000) return (ms / 60_000).toFixed(1) + " min";
  return (ms / 3_600_000).toFixed(2) + " h";
}

function compactUrl(value: string | null | undefined) {
  if (!value) return "—";
  try {
    const url = new URL(value);
    return url.hostname + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return value;
  }
}

export default async function TechnicalAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,domain,project_type")
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  const [{ data: runs }, { data: crawlSchedules }] = await Promise.all([
    supabase
      .from("crawl_runs")
    .select("id,crawl_type,status,max_urls,pages_discovered,pages_crawled,error_count,summary,execution_mode,robots_compliant,js_render_mode,crawl_config,queue_started_at,queue_completed_at,started_at,completed_at,created_at")
    .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("technical_crawl_schedules")
      .select("id,name,crawl_type,max_urls,schedule_kind,schedule_config,timezone,status,last_run_at,last_status,last_error,failure_count,batch_size,min_delay_ms,respect_robots,js_render_mode,pagespeed_enabled,pagespeed_sample_size,created_at")
      .eq("project_id", id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false }),
  ]);

  const requestedRun = scalar(query.run);
  const selectedRun =
    (runs || []).find((run) => run.id === requestedRun) ||
    (runs || [])[0] ||
    null;

  const inventoryPage = Math.max(Number(scalar(query.p, "1")) || 1, 1);
  const inventoryPageSize = 100;
  let inventoryTotal = 0;

  let pages: Array<{
    id: string;
    requested_url: string | null;
    url: string;
    final_url: string | null;
    status_code: number | null;
    response_ms: number | null;
    title: string | null;
    meta_description: string | null;
    canonical: string | null;
    robots_meta: string | null;
    x_robots_tag: string | null;
    html_lang: string | null;
    hreflangs: unknown;
    h1s: unknown;
    h2s: unknown;
    word_count: number;
    internal_link_count: number;
    external_link_count: number;
    inlink_count: number;
    crawl_depth: number | null;
    sitemap_present: boolean;
    orphan_candidate: boolean;
    indexable: boolean | null;
    indexability_reason: string | null;
    structured_data_count: number;
    invalid_structured_data_count: number;
    image_count: number;
    missing_alt_count: number;
    redirect_chain: unknown;
    fetch_error: string | null;
    content_simhash: string | null;
    near_duplicate_group: string | null;
    rendered: boolean;
    render_reason: string | null;
  }> = [];

  let findings: Array<{
    id: string;
    title: string;
    importance: string;
    summary: string;
    affected_scope: Record<string, unknown>;
    recommended_action: string | null;
    metadata: Record<string, unknown>;
  }> = [];

  let internalLinkCount = 0;
  let externalLinkCount = 0;
  let robotsAudit: null | {
    robots_url: string;
    status_code: number | null;
    fetch_status: string;
    crawl_delay_ms: number | null;
    blocks_all: boolean;
    sitemap_urls: unknown;
    error: string | null;
  } = null;
  let benchmark: CrawlBenchmark | null = null;
  const findingReviews = new Map<
    string,
    { verdict: string; note: string | null }
  >();

  let performanceResults: Array<{
    id: string;
    url: string;
    strategy: string;
    performance_score: number | null;
    lcp_ms: number | null;
    cls: number | null;
    inp_ms: number | null;
    fcp_ms: number | null;
    tbt_ms: number | null;
    fetched_at: string;
  }> = [];

  if (selectedRun) {
    const pageFrom = (inventoryPage - 1) * inventoryPageSize;
    const pageTo = pageFrom + inventoryPageSize - 1;

    const [
      pageResult,
      findingResult,
      internalLinks,
      externalLinks,
      robotsResult,
      performanceResult,
      benchmarkResult,
      reviewResult,
    ] = await Promise.all([
      supabase
        .from("crawl_pages")
        .select("id,requested_url,url,final_url,status_code,response_ms,title,meta_description,canonical,robots_meta,x_robots_tag,html_lang,hreflangs,h1s,h2s,word_count,internal_link_count,external_link_count,inlink_count,crawl_depth,sitemap_present,orphan_candidate,indexable,indexability_reason,structured_data_count,invalid_structured_data_count,image_count,missing_alt_count,redirect_chain,fetch_error,content_simhash,near_duplicate_group,rendered,render_reason", { count: "exact" })
        .eq("crawl_run_id", selectedRun.id)
        .order("crawl_depth", { ascending: true, nullsFirst: false })
        .order("url")
        .range(pageFrom, pageTo),
      supabase
        .from("findings")
        .select("id,title,importance,summary,affected_scope,recommended_action,metadata")
        .eq("project_id", id)
        .eq("metadata->>crawl_run_id", selectedRun.id)
        .order("importance")
        .limit(300),
      supabase
        .from("crawl_links")
        .select("id", { count: "exact", head: true })
        .eq("crawl_run_id", selectedRun.id)
        .eq("link_scope", "internal"),
      supabase
        .from("crawl_links")
        .select("id", { count: "exact", head: true })
        .eq("crawl_run_id", selectedRun.id)
        .eq("link_scope", "external"),
      supabase
        .from("crawl_robots_audits")
        .select("robots_url,status_code,fetch_status,crawl_delay_ms,blocks_all,sitemap_urls,error")
        .eq("crawl_run_id", selectedRun.id)
        .maybeSingle(),
      supabase
        .from("crawl_performance_results")
        .select("id,url,strategy,performance_score,lcp_ms,cls,inp_ms,fcp_ms,tbt_ms,fetched_at")
        .eq("crawl_run_id", selectedRun.id)
        .order("fetched_at", { ascending: false })
        .limit(100),
      supabase.rpc("get_crawl_run_benchmark", {
        p_run_id: selectedRun.id,
      }),
      supabase
        .from("crawl_finding_reviews")
        .select("finding_id,verdict,note")
        .eq("crawl_run_id", selectedRun.id),
    ]);

    pages = (pageResult.data || []) as typeof pages;
    inventoryTotal = pageResult.count || 0;
    findings = (findingResult.data || []) as typeof findings;
    internalLinkCount = internalLinks.count || 0;
    externalLinkCount = externalLinks.count || 0;
    robotsAudit = robotsResult.data as null | {
      robots_url: string;
      status_code: number | null;
      fetch_status: string;
      crawl_delay_ms: number | null;
      blocks_all: boolean;
      sitemap_urls: unknown;
      error: string | null;
    };
    performanceResults = (performanceResult.data || []) as typeof performanceResults;
    benchmark = (benchmarkResult.data || null) as CrawlBenchmark | null;
    for (const review of reviewResult.data || []) {
      findingReviews.set(review.finding_id, {
        verdict: review.verdict,
        note: review.note,
      });
    }
  }

  const summary = (selectedRun?.summary || {}) as Record<string, unknown>;
  const deltaSummary = (summary.delta || null) as
    | {
        baseline_run_id?: string | null;
        compared_urls?: number;
        changed_urls?: number;
        new_urls?: number;
        content_changes?: number;
        status_changes?: number;
        title_changes?: number;
        canonical_changes?: number;
        indexability_changes?: number;
      }
    | null;
  const indexablePages = pages.filter((page) => page.indexable === true).length;
  const orphanPages = pages.filter((page) => page.orphan_candidate).length;
  const redirectPages = pages.filter(
    (page) => Array.isArray(page.redirect_chain) && page.redirect_chain.length > 0,
  ).length;
  const noindexPages = pages.filter((page) =>
    [page.robots_meta, page.x_robots_tag]
      .filter(Boolean)
      .join(",")
      .toLowerCase()
      .includes("noindex"),
  ).length;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "Deterministik teknik kanıt" : "Deterministic technical evidence"}</p>
          <h1>{project.name} · {tr ? "Teknik Denetim" : "Technical Audit"}</h1>
          <p className="muted">
            {tr
              ? "Raw HTTP crawl, sitemap kapsamı, internal link graph, crawl depth, indexability ve yapılandırılmış teknik bulgular."
              : "Raw HTTP crawl, sitemap coverage, internal link graph, crawl depth, indexability and structured technical findings."}
          </p>
        </div>
        <Link href={"/projects/" + id} className="ghostButton">
          {tr ? "Projeye dön" : "Back to project"}
        </Link>
      </header>

      <ProjectDataNav projectId={id} active="technical" />

      {scalar(query.error) ? (
        <p className="formMessage formError pageMessage">{scalar(query.error)}</p>
      ) : null}
      {scalar(query.message) ? (
        <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p>
      ) : null}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{tr ? "Kontrollü raw HTTP crawl çalıştır" : "Run controlled raw HTTP crawl"}</h2>
            <p>
              {tr
                ? "SignalCore önce ana sayfadaki internal link'leri izler, ardından kapsamı sitemap URL'leriyle genişletir. Tüm crawl'lar 25 URL'den 10K production hedefine kadar aynı resumable distributed frontier üzerinde çalışır."
                : "SignalCore follows internal links from the homepage first and uses sitemap URLs for additional coverage. Every crawl uses the same resumable distributed frontier, from 25 URLs up to the 10K production target."}
            </p>
          </div>
          <span className="sourceBadge">Distributed HTTP V3</span>
        </div>

        <form className="crawlRunForm" action={runTechnicalCrawl.bind(null, id)}>
          <label>
            {tr ? "URL limiti" : "URL limit"}
            <select name="maxUrls" defaultValue="100">
              <option value="25">25 URLs · quick check</option>
              <option value="50">50 URLs</option>
              <option value="100">100 URLs · recommended</option>
              <option value="200">200 URLs</option>
              <option value="500">500 URLs · production benchmark</option>
              <option value="1000">1,000 URLs · distributed</option>
              <option value="5000">5,000 URLs · distributed</option>
              <option value="10000">10,000 URLs · distributed target</option>
            </select>
          </label>
          <label>
            JS rendering
            <select name="jsRenderMode" defaultValue="auto">
              <option value="off">Off · raw HTML only</option>
              <option value="auto">Auto · JS fallback only when needed</option>
              <option value="always">Always · expensive</option>
            </select>
          </label>
          <label className="checkboxLabel">
            <input name="pagespeedEnabled" type="checkbox" />
            {tr ? "Seçili PageSpeed örneğini kuyruğa al" : "Queue selective PageSpeed sample"}
          </label>
          <button className="primaryButton" type="submit" disabled={!project.domain}>
            {tr ? "Technical Crawl çalıştır" : "Run Technical Crawl"}
          </button>
          <span className="muted">
            {project.domain || (tr ? "Crawl öncesinde proje domain'i ekle." : "Add a project domain before crawling.")}
          </span>
        </form>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{tr ? "Arka plan crawl zamanlamaları" : "Background crawl schedules"}</h2>
            <p>
              {tr
                ? "Deterministik crawler zamanlamaları tarayıcı kapalıyken de devam eder ve AI modeline ihtiyaç duymaz."
                : "Deterministic crawler schedules continue without the browser and do not require an AI model."}
            </p>
          </div>
          <span className="sourceBadge">
            {crawlSchedules?.length || 0} configured
          </span>
        </div>

        <div className="technicalScheduleGrid">
          <form
            className="formPanel technicalScheduleForm"
            action={saveTechnicalCrawlSchedule.bind(null, id)}
          >
            <div className="formGrid2">
              <label>
                {tr ? "Zamanlama adı" : "Schedule name"}
                <input
                  name="name"
                  defaultValue="Weekly Full Crawl"
                  required
                />
              </label>
              <label>
                {tr ? "Crawl modu" : "Crawl mode"}
                <select name="crawlType" defaultValue="http">
                  <option value="http">Full HTTP crawl</option>
                  <option value="delta">Delta monitoring crawl</option>
                </select>
              </label>
              <label>
                URL limit
                <select name="maxUrls" defaultValue="500">
                  <option value="25">25 URLs</option>
                  <option value="50">50 URLs</option>
                  <option value="100">100 URLs</option>
                  <option value="200">200 URLs</option>
                  <option value="500">500 URLs · inline</option>
                  <option value="1000">1,000 URLs · distributed</option>
                  <option value="5000">5,000 URLs · distributed</option>
                  <option value="10000">10,000 URLs · distributed</option>
                  <option value="25000">25,000 URLs · distributed</option>
                  <option value="50000">50,000 URLs · distributed</option>
                </select>
              </label>
              <label>
                Batch size
                <input name="batchSize" type="number" min="5" max="100" defaultValue="50" />
              </label>
              <label>
                {tr ? "Minimum request gecikmesi (ms)" : "Minimum request delay (ms)"}
                <input name="minDelayMs" type="number" min="0" max="10000" step="50" defaultValue="250" />
              </label>
              <label>
                JS rendering
                <select name="jsRenderMode" defaultValue="auto">
                  <option value="off">Off</option>
                  <option value="auto">Auto fallback</option>
                  <option value="always">Always</option>
                </select>
              </label>
              <label className="checkboxLabel">
                <input name="pagespeedEnabled" type="checkbox" />
                {tr ? "Seçili PageSpeed denetimi" : "Selective PageSpeed audit"}
              </label>
              <label>
                {tr ? "PageSpeed örnek boyutu" : "PageSpeed sample size"}
                <input name="pagespeedSampleSize" type="number" min="0" max="100" defaultValue="20" />
              </label>
              <label>
                {tr ? "Periyot" : "Cadence"}
                <select name="scheduleKind" defaultValue="weekly">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                {tr ? "Yerel saat" : "Local time"}
                <input name="timeLocal" type="time" defaultValue="10:00" />
              </label>
              <label>
                {tr ? "Haftanın günleri" : "Week days"}
                <input
                  name="daysOfWeek"
                  defaultValue="1"
                  placeholder="1,3,5 · Sun=0"
                />
              </label>
              <label>
                {tr ? "Ayın günü" : "Month day"}
                <input
                  name="dayOfMonth"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue="1"
                />
              </label>
              <label>
                Timezone
                <input
                  name="timezone"
                  defaultValue="Europe/Istanbul"
                />
              </label>
            </div>
            <button className="primaryButton" type="submit">
              {tr ? "Crawl zamanlamasını kaydet" : "Save crawl schedule"}
            </button>
          </form>

          <div className="technicalScheduleList">
            {(crawlSchedules || []).length ? (
              (crawlSchedules || []).map((schedule) => (
                <article className="technicalScheduleCard" key={schedule.id}>
                  <div className="technicalScheduleTop">
                    <div>
                      <p className="eyebrow">
                        {schedule.crawl_type === "delta"
                          ? "Delta monitoring"
                          : "Full HTTP crawl"}
                      </p>
                      <h3>{schedule.name}</h3>
                    </div>
                    <span className={"jobStatus job-" + schedule.status}>
                      {schedule.status}
                    </span>
                  </div>
                  <p>
                    {scheduleDescription(
                      schedule.schedule_kind as ScheduleKind,
                      (schedule.schedule_config || {}) as ScheduleConfig,
                      schedule.timezone || "Europe/Istanbul",
                    )}
                  </p>
                  <div className="automationTaskMeta">
                    <span>{schedule.max_urls.toLocaleString("en-US")} URL limit</span>
                    <span>{schedule.max_urls > 500 ? "distributed" : "inline"} · batch {schedule.batch_size || 50}</span>
                    <span>delay ≥ {schedule.min_delay_ms || 0} ms · robots {schedule.respect_robots ? "on" : "off"}</span>
                    <span>JS {schedule.js_render_mode || "off"} · PSI {schedule.pagespeed_enabled ? schedule.pagespeed_sample_size + " URLs" : "off"}</span>
                    <span>Last: {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString("en-GB") : "Never"}</span>
                    <span>State: {schedule.last_status}</span>
                    <span>Failures: {schedule.failure_count || 0}</span>
                  </div>
                  {schedule.last_error ? (
                    <p className="formMessage formError">{schedule.last_error}</p>
                  ) : null}
                  <div className="buttonRow">
                    {schedule.status === "active" ? (
                      <form
                        action={setTechnicalCrawlScheduleStatus.bind(
                          null,
                          id,
                          schedule.id,
                          "paused",
                        )}
                      >
                        <button className="secondaryButton" type="submit">
                          {tr ? "Duraklat" : "Pause"}
                        </button>
                      </form>
                    ) : (
                      <form
                        action={setTechnicalCrawlScheduleStatus.bind(
                          null,
                          id,
                          schedule.id,
                          "active",
                        )}
                      >
                        <button className="secondaryButton" type="submit">
                          {tr ? "Aktive et" : "Activate"}
                        </button>
                      </form>
                    )}
                    <form
                      action={setTechnicalCrawlScheduleStatus.bind(
                        null,
                        id,
                        schedule.id,
                        "cancelled",
                      )}
                    >
                      <button className="ghostButton" type="submit">
                        {tr ? "İptal et" : "Cancel"}
                      </button>
                    </form>
                  </div>
                </article>
              ))
            ) : (
              <div className="emptyState smallEmpty">
                <strong>{tr ? "Arka plan crawl zamanlaması yok" : "No background crawl schedules"}</strong>
                <span>{tr ? "Günlük, haftalık veya aylık deterministik crawl oluştur." : "Create a daily, weekly or monthly deterministic crawl."}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {selectedRun ? (
        <>
          <section className="healthGrid technicalHealthGrid">
            <article className="healthCard">
              <span>{tr ? "Taranan sayfalar" : "Pages crawled"}</span>
              <strong>{selectedRun.pages_crawled.toLocaleString("en-US")}</strong>
              <small>
                {String(summary.sitemap_urls_discovered || 0)} sitemap URLs discovered
              </small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Indexable adaylar" : "Indexable candidates"}</span>
              <strong>{indexablePages}</strong>
              <small>{noindexPages} noindex in sample</small>
            </article>
            <article className="healthCard">
              <span>Internal links</span>
              <strong>{internalLinkCount}</strong>
              <small>{externalLinkCount} external links stored</small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Maks. crawl depth" : "Max crawl depth"}</span>
              <strong>{String(summary.max_crawl_depth ?? "—")}</strong>
              <small>Shortest internal path from homepage</small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Orphan adayları" : "Orphan candidates"}</span>
              <strong>{orphanPages}</strong>
              <small>Sitemap present · no homepage path</small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Redirect edilen sayfalar" : "Redirected pages"}</span>
              <strong>{redirectPages}</strong>
              <small>{selectedRun.error_count} fetch / HTTP errors</small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Çalışma modu" : "Execution"}</span>
              <strong>{selectedRun.execution_mode || "inline"}</strong>
              <small>
                {selectedRun.execution_mode === "queue"
                  ? String(summary.frontier_queued || 0) + " queued · " + String(summary.frontier_claimed || 0) + " claimed"
                  : selectedRun.js_render_mode + " JS mode"}
              </small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Robots uyumu" : "Robots compliance"}</span>
              <strong className={robotsAudit?.fetch_status === "failed" ? "healthBad" : "healthGood"}>
                {robotsAudit?.fetch_status || (selectedRun.robots_compliant ? "enabled" : "off")}
              </strong>
              <small>
                {robotsAudit?.crawl_delay_ms
                  ? "crawl-delay " + robotsAudit.crawl_delay_ms + " ms"
                  : "no robots crawl-delay"}
              </small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Performance örnekleri" : "Performance samples"}</span>
              <strong>{performanceResults.length}</strong>
              <small>PageSpeed / CWV results</small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Teknik bulgular" : "Technical findings"}</span>
              <strong>{findings.length}</strong>
              <small>Rule Engine V2</small>
            </article>
            <article className="healthCard">
              <span>{tr ? "Ort. response" : "Avg. response"}</span>
              <strong>
                {String(summary.avg_response_ms || "—")}
                {summary.avg_response_ms ? " ms" : ""}
              </strong>
              <small>HTTP sample</small>
            </article>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>{tr ? "Production crawl benchmark" : "Production crawl benchmark"}</h2>
                <p>
                  Run-level throughput, storage growth and manually reviewed finding quality.
                  Use this panel for the required 100 and 500 URL production acceptance tests.
                </p>
              </div>
              <span className="sourceBadge">
                {benchmark?.execution_mode || selectedRun.execution_mode || "queue"}
              </span>
            </div>
            <div className="foundationGrid">
              <div>
                <strong>Duration</strong>
                <span>{formatDuration(benchmark?.duration_ms)}</span>
              </div>
              <div>
                <strong>Throughput</strong>
                <span>
                  {benchmark?.pages_per_minute === null ||
                  benchmark?.pages_per_minute === undefined
                    ? "—"
                    : Number(benchmark.pages_per_minute).toFixed(2) + " pages/min"}
                </span>
              </div>
              <div>
                <strong>Page storage</strong>
                <span>
                  {formatBytes(benchmark?.page_bytes)} ·{" "}
                  {Number(benchmark?.page_rows || 0).toLocaleString("en-US")} rows
                </span>
              </div>
              <div>
                <strong>Link storage</strong>
                <span>
                  {formatBytes(benchmark?.link_bytes)} ·{" "}
                  {Number(benchmark?.link_rows || 0).toLocaleString("en-US")} rows
                </span>
              </div>
              <div>
                <strong>Measured DB payload</strong>
                <span>{formatBytes(benchmark?.estimated_run_bytes)}</span>
              </div>
              <div>
                <strong>Findings</strong>
                <span>
                  {Number(benchmark?.finding_count || 0)} total ·{" "}
                  {Number(benchmark?.reviewed_findings || 0)} reviewed
                </span>
              </div>
              <div>
                <strong>False-positive rate</strong>
                <span>
                  {benchmark?.false_positive_ratio === null ||
                  benchmark?.false_positive_ratio === undefined
                    ? "Review findings to measure"
                    : Number(benchmark.false_positive_ratio).toFixed(2) + "%"}
                </span>
              </div>
              <div>
                <strong>Rendered / PSI</strong>
                <span>
                  {Number(benchmark?.rendered_pages || 0)} JS ·{" "}
                  {Number(benchmark?.performance_samples || 0)} PageSpeed samples
                </span>
              </div>
            </div>
          </section>

          {selectedRun.crawl_type === "delta" && deltaSummary ? (
            <section className="panel">
              <div className="panelHeader">
                <div>
                  <h2>Delta comparison</h2>
                  <p>
                    Changes are compared with the latest previous successful crawl.
                    Unchanged page-rule findings are not re-surfaced as current-run noise.
                  </p>
                </div>
                <span className="sourceBadge">
                  baseline {deltaSummary.baseline_run_id ? deltaSummary.baseline_run_id.slice(0, 8) : "none"}
                </span>
              </div>
              <div className="foundationGrid technicalDeltaGrid">
                <div>
                  <strong>Compared URLs</strong>
                  <span>{deltaSummary.compared_urls || 0}</span>
                </div>
                <div>
                  <strong>Changed URLs</strong>
                  <span>{deltaSummary.changed_urls || 0}</span>
                </div>
                <div>
                  <strong>New URLs</strong>
                  <span>{deltaSummary.new_urls || 0}</span>
                </div>
                <div>
                  <strong>Content changes</strong>
                  <span>{deltaSummary.content_changes || 0}</span>
                </div>
                <div>
                  <strong>Status changes</strong>
                  <span>{deltaSummary.status_changes || 0}</span>
                </div>
                <div>
                  <strong>Indexability changes</strong>
                  <span>{deltaSummary.indexability_changes || 0}</span>
                </div>
                <div>
                  <strong>Title changes</strong>
                  <span>{deltaSummary.title_changes || 0}</span>
                </div>
                <div>
                  <strong>Canonical changes</strong>
                  <span>{deltaSummary.canonical_changes || 0}</span>
                </div>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Crawl inventory</h2>
                <p>
                  Requested URL, final response, indexability and internal architecture
                  evidence from the selected run.
                </p>
              </div>
              <span className={"jobStatus job-" + selectedRun.status}>
                {selectedRun.status}
              </span>
            </div>

            <div className="dataTableWrap technicalTableWrap">
              <table className="dataTable technicalTable">
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Indexable</th>
                    <th>Depth</th>
                    <th>Inlinks</th>
                    <th>Outlinks</th>
                    <th>Sitemap</th>
                    <th>Orphan</th>
                    <th>Title</th>
                    <th>H1</th>
                    <th>Words</th>
                    <th>Schema</th>
                    <th>Render</th>
                    <th>Near dup</th>
                    <th>Response</th>
                  </tr>
                </thead>
                <tbody>
                  {pages.map((page) => {
                    const h1s = Array.isArray(page.h1s) ? page.h1s : [];
                    const redirectCount = Array.isArray(page.redirect_chain)
                      ? page.redirect_chain.length
                      : 0;

                    return (
                      <tr key={page.id}>
                        <td>
                          <div className="technicalUrlCell">
                            <span className="cellEllipsis">
                              {compactUrl(page.requested_url || page.url)}
                            </span>
                            {page.final_url &&
                            page.requested_url &&
                            page.final_url !== page.requested_url ? (
                              <small>
                                → {compactUrl(page.final_url)} · {redirectCount} hop
                                {redirectCount === 1 ? "" : "s"}
                              </small>
                            ) : null}
                          </div>
                        </td>
                        <td>{page.status_code || "—"}</td>
                        <td>
                          <span
                            className={
                              page.indexable
                                ? "readinessBadge readinessReady"
                                : "readinessBadge readinessOptional"
                            }
                          >
                            {page.indexable ? "yes" : page.indexability_reason || "no"}
                          </span>
                        </td>
                        <td>{page.crawl_depth ?? "—"}</td>
                        <td>{page.inlink_count}</td>
                        <td>{page.internal_link_count}</td>
                        <td>{yesNo(page.sitemap_present)}</td>
                        <td>
                          {page.orphan_candidate ? (
                            <span className="importance importance-medium">candidate</span>
                          ) : (
                            "No"
                          )}
                        </td>
                        <td>
                          <span className="cellEllipsis">{page.title || "Missing"}</span>
                        </td>
                        <td>{h1s.length}</td>
                        <td>{page.word_count}</td>
                        <td>
                          {page.structured_data_count}
                          {page.invalid_structured_data_count
                            ? " / " + page.invalid_structured_data_count + " invalid"
                            : ""}
                        </td>
                        <td>{page.rendered ? "JS" : "HTTP"}</td>
                        <td>{page.near_duplicate_group || "—"}</td>
                        <td>{page.response_ms ? page.response_ms + " ms" : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {inventoryTotal > inventoryPageSize ? (
              <div className="buttonRow">
                {inventoryPage > 1 ? (
                  <Link
                    className="ghostButton"
                    href={
                      "/projects/" +
                      id +
                      "/technical?run=" +
                      selectedRun.id +
                      "&p=" +
                      String(inventoryPage - 1)
                    }
                  >
                    Previous 100
                  </Link>
                ) : null}
                <span className="muted">
                  Page {inventoryPage} of {Math.ceil(inventoryTotal / inventoryPageSize)} ·{" "}
                  {inventoryTotal.toLocaleString("en-US")} stored URLs
                </span>
                {inventoryPage * inventoryPageSize < inventoryTotal ? (
                  <Link
                    className="ghostButton"
                    href={
                      "/projects/" +
                      id +
                      "/technical?run=" +
                      selectedRun.id +
                      "&p=" +
                      String(inventoryPage + 1)
                    }
                  >
                    Next 100
                  </Link>
                ) : null}
              </div>
            ) : null}
          </section>

          <div className="twoCol dataTwoCol">
            <section className="panel">
              <div className="panelHeader">
                <div>
                  <h2>Technical findings</h2>
                  <p>
                    Evidence-backed issues from page rules, duplicate checks and
                    internal-link validation.
                  </p>
                </div>
              </div>

              {findings.length ? (
                <div className="technicalFindingList">
                  {findings.map((finding) => {
                    const review = findingReviews.get(finding.id);
                    return (
                      <article className="technicalFindingRow" key={finding.id}>
                        <div>
                          <span
                            className={
                              "importance importance-" + finding.importance
                            }
                          >
                            {finding.importance}
                          </span>
                          <strong>{finding.title}</strong>
                          {review ? (
                            <span
                              className={
                                review.verdict === "false_positive"
                                  ? "healthBad"
                                  : review.verdict === "confirmed"
                                    ? "healthGood"
                                    : ""
                              }
                            >
                              {review.verdict.replaceAll("_", " ")}
                            </span>
                          ) : null}
                        </div>
                        <p>{finding.summary}</p>
                        {finding.recommended_action ? (
                          <small>{finding.recommended_action}</small>
                        ) : null}
                        {review?.note ? <small>Review note: {review.note}</small> : null}
                        <div className="buttonRow">
                          {(["confirmed", "false_positive", "needs_context"] as const).map(
                            (verdict) => (
                              <form
                                key={verdict}
                                action={reviewCrawlFinding.bind(
                                  null,
                                  id,
                                  selectedRun.id,
                                  finding.id,
                                  verdict,
                                )}
                              >
                                <button
                                  className={
                                    review?.verdict === verdict
                                      ? "secondaryButton"
                                      : "ghostButton"
                                  }
                                  type="submit"
                                >
                                  {verdict.replaceAll("_", " ")}
                                </button>
                              </form>
                            ),
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="emptyState smallEmpty">
                  <span>No technical findings in this crawl.</span>
                </div>
              )}
            </section>

            <aside className="sideStack">
              <section className="panel">
                <div className="panelHeader">
                  <div>
                    <h2>Crawl coverage</h2>
                    <p>What this controlled run actually covered.</p>
                  </div>
                </div>
                <div className="foundationGrid technicalCoverageGrid">
                  <div>
                    <strong>Sitemaps checked</strong>
                    <span>{String(summary.sitemap_count || 0)}</span>
                  </div>
                  <div>
                    <strong>Sitemap URLs found</strong>
                    <span>{String(summary.sitemap_urls_discovered || 0)}</span>
                  </div>
                  <div>
                    <strong>Not crawled in sample</strong>
                    <span>
                      {String(summary.sitemap_urls_not_crawled_in_sample || 0)}
                    </span>
                  </div>
                  <div>
                    <strong>Raw crawler</strong>
                    <span>{String(summary.crawler_version || "raw-http-v3")}</span>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panelHeader">
                  <div>
                    <h2>PageSpeed / Core Web Vitals</h2>
                    <p>Selective sample only; crawler coverage does not trigger PSI for every URL.</p>
                  </div>
                </div>
                {performanceResults.length ? (
                  <div className="savedViewList">
                    {performanceResults.slice(0, 20).map((result) => (
                      <div className="savedViewRow" key={result.id}>
                        <strong>{compactUrl(result.url)}</strong>
                        <span>
                          Score {result.performance_score === null ? "—" : Math.round(result.performance_score * 100)}
                          {" · "}LCP {result.lcp_ms === null ? "—" : Math.round(result.lcp_ms) + " ms"}
                          {" · "}CLS {result.cls === null ? "—" : Number(result.cls).toFixed(3)}
                          {" · "}INP {result.inp_ms === null ? "—" : Math.round(result.inp_ms) + " ms"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="emptyState smallEmpty">
                    <span>No PageSpeed results for this run yet.</span>
                  </div>
                )}
              </section>

              <section className="panel">
                <div className="panelHeader">
                  <div>
                    <h2>Recent crawl runs</h2>
                    <p>Compare controlled samples over time.</p>
                  </div>
                </div>
                <div className="savedViewList">
                  {(runs || []).map((run) => (
                    <Link
                      key={run.id}
                      className="savedViewRow"
                      href={"/projects/" + id + "/technical?run=" + run.id}
                    >
                      <strong>{new Date(run.created_at).toLocaleString("en-GB")}</strong>
                      <span>
                        {run.pages_crawled} pages · {run.error_count} errors
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <section className="panel emptyState">
          <strong>No crawl runs yet</strong>
          <span>
            Run the first controlled crawl above or ask Chief Operator to run a
            technical audit.
          </span>
        </section>
      )}
    </div>
  );
}
