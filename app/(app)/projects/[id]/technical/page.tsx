
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { createClient } from "@/lib/supabase/server";
import { runTechnicalCrawl } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function yesNo(value: boolean | null | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
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
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,domain,project_type")
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  const { data: runs } = await supabase
    .from("crawl_runs")
    .select("id,crawl_type,status,max_urls,pages_discovered,pages_crawled,error_count,summary,started_at,completed_at,created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(10);

  const requestedRun = scalar(query.run);
  const selectedRun =
    (runs || []).find((run) => run.id === requestedRun) ||
    (runs || [])[0] ||
    null;

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

  if (selectedRun) {
    const [pageResult, findingResult, internalLinks, externalLinks] =
      await Promise.all([
        supabase
          .from("crawl_pages")
          .select("id,requested_url,url,final_url,status_code,response_ms,title,meta_description,canonical,robots_meta,x_robots_tag,html_lang,hreflangs,h1s,h2s,word_count,internal_link_count,external_link_count,inlink_count,crawl_depth,sitemap_present,orphan_candidate,indexable,indexability_reason,structured_data_count,invalid_structured_data_count,image_count,missing_alt_count,redirect_chain,fetch_error")
          .eq("crawl_run_id", selectedRun.id)
          .order("crawl_depth", { ascending: true, nullsFirst: false })
          .order("url")
          .limit(500),
        supabase
          .from("findings")
          .select("id,title,importance,summary,affected_scope,recommended_action,metadata")
          .eq("project_id", id)
          .eq("metadata->>crawl_run_id", selectedRun.id)
          .order("importance")
          .limit(200),
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
      ]);

    pages = (pageResult.data || []) as typeof pages;
    findings = (findingResult.data || []) as typeof findings;
    internalLinkCount = internalLinks.count || 0;
    externalLinkCount = externalLinks.count || 0;
  }

  const summary = (selectedRun?.summary || {}) as Record<string, unknown>;
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
          <p className="eyebrow">Deterministic technical evidence</p>
          <h1>{project.name} · Technical Audit</h1>
          <p className="muted">
            Raw HTTP crawl, sitemap coverage, internal link graph, crawl depth,
            indexability and structured technical findings.
          </p>
        </div>
        <Link href={"/projects/" + id} className="ghostButton">
          Back to project
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
            <h2>Run controlled raw HTTP crawl</h2>
            <p>
              SignalCore follows internal links from the homepage first and uses
              sitemap URLs for additional coverage. The current synchronous
              runner is capped at 500 URLs per run.
            </p>
          </div>
          <span className="sourceBadge">Raw HTTP V2</span>
        </div>

        <form className="crawlRunForm" action={runTechnicalCrawl.bind(null, id)}>
          <label>
            URL limit
            <select name="maxUrls" defaultValue="100">
              <option value="25">25 URLs · quick check</option>
              <option value="50">50 URLs</option>
              <option value="100">100 URLs · recommended</option>
              <option value="200">200 URLs</option>
              <option value="500">500 URLs · deeper sample</option>
            </select>
          </label>
          <button className="primaryButton" type="submit" disabled={!project.domain}>
            Run Technical Crawl
          </button>
          <span className="muted">
            {project.domain || "Add a project domain before crawling."}
          </span>
        </form>
      </section>

      {selectedRun ? (
        <>
          <section className="healthGrid technicalHealthGrid">
            <article className="healthCard">
              <span>Pages crawled</span>
              <strong>{selectedRun.pages_crawled}</strong>
              <small>
                {String(summary.sitemap_urls_discovered || 0)} sitemap URLs discovered
              </small>
            </article>
            <article className="healthCard">
              <span>Indexable candidates</span>
              <strong>{indexablePages}</strong>
              <small>{noindexPages} noindex in sample</small>
            </article>
            <article className="healthCard">
              <span>Internal links</span>
              <strong>{internalLinkCount}</strong>
              <small>{externalLinkCount} external links stored</small>
            </article>
            <article className="healthCard">
              <span>Max crawl depth</span>
              <strong>{String(summary.max_crawl_depth ?? "—")}</strong>
              <small>Shortest internal path from homepage</small>
            </article>
            <article className="healthCard">
              <span>Orphan candidates</span>
              <strong>{orphanPages}</strong>
              <small>Sitemap present · no homepage path</small>
            </article>
            <article className="healthCard">
              <span>Redirected pages</span>
              <strong>{redirectPages}</strong>
              <small>{selectedRun.error_count} fetch / HTTP errors</small>
            </article>
            <article className="healthCard">
              <span>Technical findings</span>
              <strong>{findings.length}</strong>
              <small>Rule Engine V2</small>
            </article>
            <article className="healthCard">
              <span>Avg. response</span>
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
                        <td>{page.response_ms ? page.response_ms + " ms" : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
                  {findings.map((finding) => (
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
                      </div>
                      <p>{finding.summary}</p>
                      {finding.recommended_action ? (
                        <small>{finding.recommended_action}</small>
                      ) : null}
                    </article>
                  ))}
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
                    <span>{String(summary.crawler_version || "raw-http-v2")}</span>
                  </div>
                </div>
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
