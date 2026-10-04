import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { getProjectGoogleResource } from "@/lib/google/project-resource";
import {
  querySearchConsole,
  type GscDimension,
  type GscFilter,
  type GscRow,
} from "@/lib/google/search-console";
import { createClient } from "@/lib/supabase/server";
import { runGscOpportunityScan, saveGscView } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

const PRESETS: Record<string, { label: string; dimensions: GscDimension[] }> = {
  queries: { label: "Queries", dimensions: ["query"] },
  pages: { label: "Pages", dimensions: ["page"] },
  query_page: { label: "Query × Page", dimensions: ["query", "page"] },
  countries: { label: "Countries", dimensions: ["country"] },
  devices: { label: "Devices", dimensions: ["device"] },
  appearance: { label: "Search Appearance", dimensions: ["searchAppearance"] },
  dates: { label: "Daily Trend", dimensions: ["date"] },
};

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function isoDate(daysAgo: number) {
  const date = new Date(Date.now() - daysAgo * 86400000);
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: number | undefined) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatMetric(value: number | undefined, metric: string) {
  if (metric === "ctr") return `${((value || 0) * 100).toFixed(2)}%`;
  if (metric === "position") return (value || 0).toFixed(2);
  return formatNumber(value);
}

function savedViewHref(projectId: string, config: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  params.set("run", "1");
  return `/projects/${projectId}/search-console?${params.toString()}`;
}

function sortRows(rows: GscRow[], metric: string) {
  return [...rows].sort((a, b) => {
    const left = Number((a as Record<string, unknown>)[metric] || 0);
    const right = Number((b as Record<string, unknown>)[metric] || 0);
    return metric === "position" ? left - right : right - left;
  });
}

export default async function SearchConsolePage({
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

  let resource: Awaited<ReturnType<typeof getProjectGoogleResource>> | null = null;
  let bindingError = "";
  try {
    resource = await getProjectGoogleResource(id, "gsc");
  } catch (error) {
    bindingError = error instanceof Error ? error.message : "GSC property is unavailable.";
  }

  const [
    { data: savedViews },
    { data: warehouseStates },
    { data: queryPageInsightData },
  ] = await Promise.all([
    supabase
      .from("saved_analytics_views")
      .select("id,name,config,created_at")
      .eq("project_id", id)
      .eq("data_source", "gsc")
      .order("updated_at", { ascending: false })
      .limit(20),
    supabase
      .from("google_sync_states")
      .select("dataset,status,last_complete_date,last_success_at,rows_total,last_error")
      .eq("project_id", id)
      .eq("source", "gsc"),
    supabase.rpc("get_gsc_query_page_insights", {
      p_project_id: id,
      p_days: 28,
      p_min_impressions: 100,
      p_limit: 50,
    }),
  ]);

  const warehouseStateMap = new Map(
    (warehouseStates || []).map((state) => [state.dataset, state]),
  );
  const queryPageInsights =
    (queryPageInsightData || {}) as Record<string, unknown>;
  const ownershipSplits = Array.isArray(queryPageInsights.ownership_splits)
    ? (queryPageInsights.ownership_splits as Array<Record<string, unknown>>)
    : [];
  const urlSwitches = Array.isArray(queryPageInsights.url_switches)
    ? (queryPageInsights.url_switches as Array<Record<string, unknown>>)
    : [];

  const presetKey = PRESETS[scalar(query.view, "queries")]
    ? scalar(query.view, "queries")
    : "queries";
  const preset = PRESETS[presetKey];
  const startDate = scalar(query.start, isoDate(30));
  const endDate = scalar(query.end, isoDate(3));
  const searchType = scalar(query.searchType, "web") as
    | "web"
    | "image"
    | "video"
    | "news"
    | "discover"
    | "googleNews";
  const dataState = scalar(query.dataState, "final") as "final" | "all";
  const filterDimension = scalar(query.filterDimension, "query") as Exclude<GscDimension, "date">;
  const filterOperator = scalar(query.filterOperator, "contains") as GscFilter["operator"];
  const filterValue = scalar(query.filterValue);
  const rowLimit = Math.min(Math.max(Number(scalar(query.rows, "100")) || 100, 10), 1000);
  const sortMetric = scalar(query.sort, "clicks");
  const shouldRun = scalar(query.run, "1") === "1";

  const filters: GscFilter[] = filterValue
    ? [{ dimension: filterDimension, operator: filterOperator, expression: filterValue }]
    : [];

  let rows: GscRow[] = [];
  let summary: GscRow | null = null;
  let trendRows: GscRow[] = [];
  let queryError = "";

  if (resource && shouldRun) {
    try {
      const [main, totals, trend] = await Promise.all([
        querySearchConsole({
          siteUrl: resource.resource_id,
          startDate,
          endDate,
          dimensions: preset.dimensions,
          searchType,
          dataState,
          filters,
          rowLimit,
        }),
        querySearchConsole({
          siteUrl: resource.resource_id,
          startDate,
          endDate,
          dimensions: [],
          searchType,
          dataState,
          filters,
          rowLimit: 1,
        }),
        querySearchConsole({
          siteUrl: resource.resource_id,
          startDate,
          endDate,
          dimensions: ["date"],
          searchType,
          dataState,
          filters,
          rowLimit: 1000,
        }),
      ]);

      rows = sortRows(main.rows || [], sortMetric);
      summary = totals.rows?.[0] || null;
      trendRows = trend.rows || [];
    } catch (error) {
      queryError = error instanceof Error ? error.message : "Search Console query failed.";
    }
  }

  const currentConfig = {
    view: presetKey,
    start: startDate,
    end: endDate,
    searchType,
    dataState,
    filterDimension,
    filterOperator,
    filterValue,
    rows: rowLimit,
    sort: sortMetric,
  };

  const domainMismatch =
    resource &&
    project.domain &&
    !resource.resource_id.toLowerCase().includes(project.domain.toLowerCase());

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Manual analyst workspace</p>
          <h1>{project.name} · Search Console</h1>
          <p className="muted">
            Explore first-party GSC data manually. Automation and Opportunity Engine will use the same property separately.
          </p>
        </div>
        <div className="buttonRow">
          <form action={runGscOpportunityScan.bind(null, id)}>
            <button className="primaryButton" type="submit" disabled={!resource}>Run Opportunity Scan</button>
          </form>
          <Link href={`/projects/${id}`} className="ghostButton">Back to project</Link>
        </div>
      </header>

      <ProjectDataNav projectId={id} active="gsc" />

      {bindingError ? (
        <section className="panel formMessage formError">
          {bindingError} <Link href={`/projects/${id}`}><strong>Choose a GSC property</strong></Link>
        </section>
      ) : null}

      {domainMismatch ? (
        <p className="formMessage formError pageMessage">
          Warning: project domain is <strong>{project.domain}</strong>, but the selected GSC property is <strong>{resource?.resource_id}</strong>. Check the project binding before relying on the data.
        </p>
      ) : null}

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}
      {queryError ? <p className="formMessage formError pageMessage">{queryError}</p> : null}

      <section className="healthGrid">
        {[
          ["page_daily", "Page warehouse"],
          ["query_daily", "Query warehouse"],
          ["query_page_daily", "Query × Page warehouse"],
        ].map(([dataset, label]) => {
          const state = warehouseStateMap.get(dataset);
          return (
            <article className="healthCard" key={dataset}>
              <span>{label}</span>
              <strong>{state?.last_complete_date || "—"}</strong>
              <small>
                {state
                  ? String(state.rows_total || 0) + " rows · " + state.status
                  : "Not synced yet"}
              </small>
            </article>
          );
        })}
      </section>

      <section className="panel explorerToolbar">
        <form method="get" className="explorerForm">
          <input type="hidden" name="run" value="1" />

          <label>
            Report
            <select name="view" defaultValue={presetKey}>
              {Object.entries(PRESETS).map(([key, value]) => (
                <option key={key} value={key}>{value.label}</option>
              ))}
            </select>
          </label>

          <label>
            Start
            <input type="date" name="start" defaultValue={startDate} />
          </label>

          <label>
            End
            <input type="date" name="end" defaultValue={endDate} />
          </label>

          <label>
            Search type
            <select name="searchType" defaultValue={searchType}>
              <option value="web">Web</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="news">News</option>
              <option value="discover">Discover</option>
              <option value="googleNews">Google News</option>
            </select>
          </label>

          <label>
            Data
            <select name="dataState" defaultValue={dataState}>
              <option value="final">Final</option>
              <option value="all">Fresh + final</option>
            </select>
          </label>

          <label>
            Filter field
            <select name="filterDimension" defaultValue={filterDimension}>
              <option value="query">Query</option>
              <option value="page">Page</option>
              <option value="country">Country</option>
              <option value="device">Device</option>
              <option value="searchAppearance">Search appearance</option>
            </select>
          </label>

          <label>
            Operator
            <select name="filterOperator" defaultValue={filterOperator}>
              <option value="contains">Contains</option>
              <option value="equals">Equals</option>
              <option value="notContains">Does not contain</option>
              <option value="notEquals">Not equal</option>
              <option value="includingRegex">Regex include</option>
              <option value="excludingRegex">Regex exclude</option>
            </select>
          </label>

          <label className="wideControl">
            Filter value
            <input name="filterValue" defaultValue={filterValue} placeholder="e.g. protein, /blog/, TUR" />
          </label>

          <label>
            Sort
            <select name="sort" defaultValue={sortMetric}>
              <option value="clicks">Clicks</option>
              <option value="impressions">Impressions</option>
              <option value="ctr">CTR</option>
              <option value="position">Position</option>
            </select>
          </label>

          <label>
            Rows
            <select name="rows" defaultValue={String(rowLimit)}>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="250">250</option>
              <option value="500">500</option>
              <option value="1000">1,000</option>
            </select>
          </label>

          <button className="primaryButton" type="submit" disabled={!resource}>Run report</button>
        </form>
      </section>

      {resource ? (
        <section className="dataContextBar">
          <div><strong>Property</strong><span>{resource.resource_id}</span></div>
          <div><strong>Period</strong><span>{startDate} → {endDate}</span></div>
          <div><strong>Mode</strong><span>{dataState === "all" ? "Fresh + final" : "Final data"}</span></div>
        </section>
      ) : null}

      <section className="statsGrid">
        <article className="statCard"><span>Clicks</span><strong>{formatNumber(summary?.clicks)}</strong><small>Selected period & filters</small></article>
        <article className="statCard"><span>Impressions</span><strong>{formatNumber(summary?.impressions)}</strong><small>Selected period & filters</small></article>
        <article className="statCard"><span>CTR</span><strong>{formatMetric(summary?.ctr, "ctr")}</strong><small>Clicks / impressions</small></article>
        <article className="statCard"><span>Avg. position</span><strong>{formatMetric(summary?.position, "position")}</strong><small>Search Console average</small></article>
      </section>

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>{preset.label}</h2><p>{rows.length} rows loaded for manual review.</p></div>
          </div>

          {rows.length ? (
            <div className="dataTableWrap">
              <table className="dataTable">
                <thead>
                  <tr>
                    {preset.dimensions.map((dimension) => <th key={dimension}>{dimension}</th>)}
                    <th>Clicks</th>
                    <th>Impressions</th>
                    <th>CTR</th>
                    <th>Position</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      {preset.dimensions.map((dimension, dimensionIndex) => (
                        <td key={dimension}><span className="cellEllipsis">{row.keys?.[dimensionIndex] || "—"}</span></td>
                      ))}
                      <td>{formatNumber(row.clicks)}</td>
                      <td>{formatNumber(row.impressions)}</td>
                      <td>{formatMetric(row.ctr, "ctr")}</td>
                      <td>{formatMetric(row.position, "position")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState smallEmpty"><strong>No rows</strong><span>Run a report or adjust the selected filters.</span></div>
          )}
        </section>

        <aside className="sideStack">
          <section className="panel">
            <div className="panelHeader"><div><h2>Daily trend</h2><p>Compact manual trend check.</p></div></div>
            {trendRows.length ? (
              <div className="trendList">
                {trendRows.slice(-14).map((row, index) => (
                  <div className="trendRow" key={index}>
                    <span>{row.keys?.[0]}</span>
                    <div className="trendMetrics">
                      <strong>{formatNumber(row.clicks)} clicks</strong>
                      <small>{formatNumber(row.impressions)} imp.</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>No trend data yet.</span></div>
            )}
          </section>

          <section className="panel">
            <div className="panelHeader"><div><h2>Rule Engine</h2><p>Deterministic first-pass opportunity detection.</p></div></div>
            <div className="ruleList">
              <span>Striking-distance queries</span>
              <span>High-impression / low-CTR queries</span>
              <span>Rising and declining queries</span>
              <span>New and lost visibility queries</span>
              <span>Declining landing pages</span>
              <span>Query ownership split across multiple URLs</span>
              <span>Dominant ranking URL switches</span>
            </div>
            <form action={runGscOpportunityScan.bind(null, id)}>
              <button className="primaryButton fullButton" type="submit" disabled={!resource}>Run 28-day Opportunity Scan</button>
            </form>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Query ownership evidence</h2>
                <p>Warehouse-only signals. Review before calling anything cannibalization.</p>
              </div>
            </div>
            {ownershipSplits.length || urlSwitches.length ? (
              <div className="trendList">
                {ownershipSplits.slice(0, 5).map((item, index) => (
                  <div className="trendRow" key={"split-" + index}>
                    <span>{String(item.query || "Query")}</span>
                    <div className="trendMetrics">
                      <strong>
                        {String(item.page_count || 0)} URLs ·{" "}
                        {Math.round(Number(item.top_page_share || 0) * 100)}% top owner
                      </strong>
                      <small>
                        {formatNumber(Number(item.total_impressions || 0))} imp.
                      </small>
                    </div>
                  </div>
                ))}
                {urlSwitches.slice(0, 5).map((item, index) => (
                  <div className="trendRow" key={"switch-" + index}>
                    <span>{String(item.query || "Query")}</span>
                    <div className="trendMetrics">
                      <strong>Dominant URL changed</strong>
                      <small>
                        {String(item.current_top_page || "—")}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty">
                <span>No query ownership evidence yet. Query × Page warehouse data must sync first.</span>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panelHeader"><div><h2>Save this view</h2><p>Reuse your own GSC checks later.</p></div></div>
            <form className="formPanel compactForm" action={saveGscView.bind(null, id)}>
              <input type="hidden" name="config" value={JSON.stringify(currentConfig)} />
              <label>View name<input name="name" placeholder="e.g. Protein queries · 28 days" required /></label>
              <button className="secondaryButton" type="submit">Save view</button>
            </form>
          </section>

          <section className="panel">
            <div className="panelHeader"><div><h2>Saved GSC views</h2><p>{savedViews?.length || 0} custom views.</p></div></div>
            {savedViews?.length ? (
              <div className="savedViewList">
                {savedViews.map((view) => (
                  <Link
                    key={view.id}
                    className="savedViewRow"
                    href={savedViewHref(id, (view.config || {}) as Record<string, unknown>)}
                  >
                    <strong>{view.name}</strong><span>Open</span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="emptyState smallEmpty"><span>No saved GSC views yet.</span></div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
