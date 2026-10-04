import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { createClient } from "@/lib/supabase/server";
import { runTechnicalCrawl } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
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
    url: string;
    status_code: number | null;
    response_ms: number | null;
    title: string | null;
    canonical: string | null;
    robots_meta: string | null;
    h1s: unknown;
    word_count: number;
    internal_link_count: number;
    structured_data_count: number;
    fetch_error: string | null;
  }> = [];

  let findings: Array<{
    id: string;
    title: string;
    importance: string;
    summary: string;
    affected_scope: Record<string, unknown>;
  }> = [];

  if (selectedRun) {
    const [pageResult, findingResult] = await Promise.all([
      supabase
        .from("crawl_pages")
        .select("id,url,status_code,response_ms,title,canonical,robots_meta,h1s,word_count,internal_link_count,structured_data_count,fetch_error")
        .eq("crawl_run_id", selectedRun.id)
        .order("url")
        .limit(500),
      supabase
        .from("findings")
        .select("id,title,importance,summary,affected_scope")
        .eq("project_id", id)
        .eq("metadata->>crawl_run_id", selectedRun.id)
        .order("importance"),
    ]);
    pages = pageResult.data || [];
    findings = (findingResult.data || []) as typeof findings;
  }

  const summary = (selectedRun?.summary || {}) as Record<string, unknown>;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Deterministic technical evidence</p>
          <h1>{project.name} · Technical Audit</h1>
          <p className="muted">
            Controlled HTTP crawl with sitemap discovery, template-safe limits and structured technical findings.
          </p>
        </div>
        <Link href={`/projects/${id}`} className="ghostButton">Back to project</Link>
      </header>

      <ProjectDataNav projectId={id} active="technical" />

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Run controlled crawl</h2>
            <p>
              Use a small sample for large sites. SignalCore discovers sitemap URLs but will stop at your selected limit.
            </p>
          </div>
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
          <section className="statsGrid">
            <article className="statCard">
              <span>Pages crawled</span>
              <strong>{selectedRun.pages_crawled}</strong>
              <small>{selectedRun.pages_discovered} discovered</small>
            </article>
            <article className="statCard">
              <span>Technical findings</span>
              <strong>{findings.length}</strong>
              <small>Rule Engine V1</small>
            </article>
            <article className="statCard">
              <span>Errors</span>
              <strong>{selectedRun.error_count}</strong>
              <small>Fetch or HTTP errors</small>
            </article>
            <article className="statCard">
              <span>Avg. response</span>
              <strong>{String(summary.avg_response_ms || "—")}{summary.avg_response_ms ? " ms" : ""}</strong>
              <small>HTTP sample</small>
            </article>
          </section>

          <div className="twoCol dataTwoCol">
            <section className="panel">
              <div className="panelHeader">
                <div>
                  <h2>Crawled pages</h2>
                  <p>{pages.length} page snapshots from the selected run.</p>
                </div>
                <span className={`jobStatus job-${selectedRun.status}`}>{selectedRun.status}</span>
              </div>

              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th>Status</th>
                      <th>Title</th>
                      <th>H1</th>
                      <th>Words</th>
                      <th>Links</th>
                      <th>Response</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((page) => {
                      const h1s = Array.isArray(page.h1s) ? page.h1s : [];
                      return (
                        <tr key={page.id}>
                          <td><span className="cellEllipsis">{page.url}</span></td>
                          <td>{page.status_code || "—"}</td>
                          <td><span className="cellEllipsis">{page.title || "Missing"}</span></td>
                          <td>{h1s.length}</td>
                          <td>{page.word_count}</td>
                          <td>{page.internal_link_count}</td>
                          <td>{page.response_ms ? `${page.response_ms} ms` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <aside className="sideStack">
              <section className="panel">
                <div className="panelHeader">
                  <div><h2>Technical findings</h2><p>Evidence-backed rule detections.</p></div>
                </div>
                {findings.length ? (
                  <div className="technicalFindingList">
                    {findings.slice(0, 30).map((finding) => (
                      <div className="technicalFindingRow" key={finding.id}>
                        <div>
                          <span className={`importance importance-${finding.importance}`}>{finding.importance}</span>
                          <strong>{finding.title}</strong>
                        </div>
                        <p>{finding.summary}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="emptyState smallEmpty"><span>No technical findings in this crawl.</span></div>
                )}
              </section>

              <section className="panel">
                <div className="panelHeader">
                  <div><h2>Recent crawl runs</h2><p>Compare controlled samples over time.</p></div>
                </div>
                <div className="savedViewList">
                  {(runs || []).map((run) => (
                    <Link
                      key={run.id}
                      className="savedViewRow"
                      href={`/projects/${id}/technical?run=${run.id}`}
                    >
                      <strong>{new Date(run.created_at).toLocaleString("en-GB")}</strong>
                      <span>{run.pages_crawled} pages</span>
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
          <span>Run the first controlled crawl above or ask Chief Operator to run a technical audit.</span>
        </section>
      )}
    </div>
  );
}
