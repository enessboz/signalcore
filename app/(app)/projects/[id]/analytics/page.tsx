import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { getProjectGoogleResource } from "@/lib/google/project-resource";
import {
  runGa4Funnel,
  runGa4Report,
  type Ga4ReportResponse,
  type Ga4Row,
} from "@/lib/google/analytics";
import { createClient } from "@/lib/supabase/server";
import { saveGa4Funnel, saveGa4View } from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;

type ReportPreset = {
  label: string;
  dimensions: string[];
  metrics: string[];
  description: string;
};

const PRESETS: Record<string, ReportPreset> = {
  landing_pages: {
    label: "Landing Pages",
    dimensions: ["landingPagePlusQueryString"],
    metrics: ["sessions", "activeUsers", "newUsers", "engagedSessions", "engagementRate", "keyEvents"],
    description: "SEO-friendly landing-page performance.",
  },
  pages: {
    label: "Pages & Screens",
    dimensions: ["pagePathPlusQueryString"],
    metrics: ["screenPageViews", "activeUsers", "userEngagementDuration", "keyEvents"],
    description: "Page consumption and engagement.",
  },
  channels: {
    label: "Channel Groups",
    dimensions: ["sessionPrimaryChannelGroup"],
    metrics: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents"],
    description: "Traffic acquisition by primary channel group.",
  },
  source_medium: {
    label: "Source / Medium",
    dimensions: ["sessionSource", "sessionMedium"],
    metrics: ["sessions", "activeUsers", "engagedSessions", "keyEvents"],
    description: "Acquisition detail by session source and medium.",
  },
  events: {
    label: "Events",
    dimensions: ["eventName"],
    metrics: ["eventCount", "activeUsers", "keyEvents"],
    description: "Event inventory and activity.",
  },
  devices: {
    label: "Devices",
    dimensions: ["deviceCategory"],
    metrics: ["sessions", "activeUsers", "engagementRate", "keyEvents"],
    description: "Device-level performance.",
  },
  countries: {
    label: "Countries",
    dimensions: ["country"],
    metrics: ["sessions", "activeUsers", "engagementRate", "keyEvents"],
    description: "Country-level performance.",
  },
};

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function isoDate(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

function commaList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatValue(value: string | undefined, metricName?: string) {
  if (value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return value;

  if (metricName && /Rate$/i.test(metricName)) {
    return `${(number * 100).toFixed(2)}%`;
  }

  if (Math.abs(number) >= 1000) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(number);
  }

  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number);
}

function savedHref(
  projectId: string,
  base: "analytics",
  config: Record<string, unknown>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  params.set("run", "1");
  return `/projects/${projectId}/${base}?${params.toString()}`;
}

function metricValue(row: Ga4Row | undefined, index: number) {
  return row?.metricValues?.[index]?.value;
}

export default async function AnalyticsPage({
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
    .select("id,name,domain")
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  let resource: Awaited<ReturnType<typeof getProjectGoogleResource>> | null = null;
  let bindingError = "";
  try {
    resource = await getProjectGoogleResource(id, "ga4");
  } catch (error) {
    bindingError = error instanceof Error ? error.message : "GA4 property is unavailable.";
  }

  const [{ data: savedViews }, { data: savedFunnels }] = await Promise.all([
    supabase
      .from("saved_analytics_views")
      .select("id,name,config,created_at")
      .eq("project_id", id)
      .eq("data_source", "ga4")
      .order("updated_at", { ascending: false })
      .limit(20),
    supabase
      .from("ga4_funnels")
      .select("id,name,config,created_at")
      .eq("project_id", id)
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  const mode = scalar(query.mode, "report") === "funnel" ? "funnel" : "report";
  const startDate = scalar(query.start, isoDate(30));
  const endDate = scalar(query.end, isoDate(1));

  const presetKey = PRESETS[scalar(query.preset, "landing_pages")]
    ? scalar(query.preset, "landing_pages")
    : "landing_pages";
  const preset = PRESETS[presetKey];

  const customDimensions = commaList(scalar(query.dimensions));
  const customMetrics = commaList(scalar(query.metrics));
  const dimensions = customDimensions.length ? customDimensions : preset.dimensions;
  const metrics = customMetrics.length ? customMetrics : preset.metrics;
  const filterField = scalar(query.filterField);
  const filterValue = scalar(query.filterValue);
  const filterMatch = scalar(query.filterMatch, "CONTAINS") as
    | "EXACT"
    | "CONTAINS"
    | "BEGINS_WITH"
    | "ENDS_WITH"
    | "FULL_REGEXP"
    | "PARTIAL_REGEXP";
  const rowLimit = Math.min(Math.max(Number(scalar(query.rows, "100")) || 100, 10), 1000);

  const stepInputs = [1, 2, 3, 4, 5]
    .map((index) => ({
      name: scalar(query[`step${index}Name`], index === 1 ? "Step 1" : index === 2 ? "Step 2" : ""),
      eventName: scalar(
        query[`step${index}Event`],
        index === 1 ? "session_start" : index === 2 ? "purchase" : "",
      ),
    }))
    .filter((step) => step.name && step.eventName);

  const breakdownDimension = scalar(query.breakdown);
  const isOpenFunnel = scalar(query.openFunnel) === "1";
  const shouldRun = scalar(query.run, "1") === "1";

  let report: Ga4ReportResponse | null = null;
  let funnel: Awaited<ReturnType<typeof runGa4Funnel>> | null = null;
  let queryError = "";

  if (resource && shouldRun) {
    try {
      if (mode === "report") {
        report = await runGa4Report({
          property: resource.resource_id,
          startDate,
          endDate,
          dimensions,
          metrics,
          dimensionFilters:
            filterField && filterValue
              ? [{ fieldName: filterField, matchType: filterMatch, value: filterValue }]
              : [],
          limit: rowLimit,
        });
      } else {
        if (stepInputs.length < 2) {
          throw new Error("A funnel needs at least two valid event steps.");
        }

        funnel = await runGa4Funnel({
          property: resource.resource_id,
          startDate,
          endDate,
          steps: stepInputs,
          breakdownDimension: breakdownDimension || undefined,
          isOpenFunnel,
        });
      }
    } catch (error) {
      queryError = error instanceof Error ? error.message : "GA4 query failed.";
    }
  }

  const reportConfig = {
    mode: "report",
    preset: presetKey,
    start: startDate,
    end: endDate,
    dimensions: customDimensions.join(","),
    metrics: customMetrics.join(","),
    filterField,
    filterValue,
    filterMatch,
    rows: rowLimit,
  };

  const funnelConfig = {
    mode: "funnel",
    start: startDate,
    end: endDate,
    breakdown: breakdownDimension,
    openFunnel: isOpenFunnel ? 1 : 0,
    ...Object.fromEntries(
      stepInputs.flatMap((step, index) => [
        [`step${index + 1}Name`, step.name],
        [`step${index + 1}Event`, step.eventName],
      ]),
    ),
  };

  const totals = report?.totals?.[0];
  const metricHeaders = report?.metricHeaders || [];
  const dimensionHeaders = report?.dimensionHeaders || [];

  const domainMismatch =
    resource &&
    project.domain &&
    resource.display_name &&
    project.name.toLowerCase() !== resource.display_name.toLowerCase() &&
    resource.display_name.toLowerCase().includes("eatbetter") &&
    !project.domain.toLowerCase().includes("eatbetter");

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Manual analytics workspace</p>
          <h1>{project.name} · GA4 Analytics Studio</h1>
          <p className="muted">
            Build reusable reports and event funnels without leaving SignalCore.
          </p>
        </div>
        <Link href={`/projects/${id}`} className="ghostButton">Back to project</Link>
      </header>

      <ProjectDataNav projectId={id} active="ga4" />

      {bindingError ? (
        <section className="panel formMessage formError">
          {bindingError} <Link href={`/projects/${id}`}><strong>Choose a GA4 property</strong></Link>
        </section>
      ) : null}

      {domainMismatch ? (
        <p className="formMessage formError pageMessage">
          Warning: the selected GA4 property is <strong>{resource?.display_name}</strong> ({resource?.resource_id}), which appears unrelated to <strong>{project.name}</strong>. Check the project binding.
        </p>
      ) : null}

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}
      {queryError ? <p className="formMessage formError pageMessage">{queryError}</p> : null}

      <div className="modeTabs">
        <Link className={mode === "report" ? "modeTab active" : "modeTab"} href={`/projects/${id}/analytics?mode=report`}>
          Report Builder
        </Link>
        <Link className={mode === "funnel" ? "modeTab active" : "modeTab"} href={`/projects/${id}/analytics?mode=funnel`}>
          Funnel Builder
        </Link>
      </div>

      {mode === "report" ? (
        <>
          <section className="panel explorerToolbar">
            <form method="get" className="explorerForm">
              <input type="hidden" name="mode" value="report" />
              <input type="hidden" name="run" value="1" />

              <label>
                Preset
                <select name="preset" defaultValue={presetKey}>
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

              <label className="wideControl">
                Custom dimensions
                <input
                  name="dimensions"
                  defaultValue={customDimensions.join(",")}
                  placeholder={preset.dimensions.join(", ")}
                />
              </label>

              <label className="wideControl">
                Custom metrics
                <input
                  name="metrics"
                  defaultValue={customMetrics.join(",")}
                  placeholder={preset.metrics.join(", ")}
                />
              </label>

              <label>
                Filter dimension
                <input name="filterField" defaultValue={filterField} placeholder="e.g. sessionMedium" />
              </label>

              <label>
                Match
                <select name="filterMatch" defaultValue={filterMatch}>
                  <option value="CONTAINS">Contains</option>
                  <option value="EXACT">Exact</option>
                  <option value="BEGINS_WITH">Begins with</option>
                  <option value="ENDS_WITH">Ends with</option>
                  <option value="FULL_REGEXP">Full regex</option>
                  <option value="PARTIAL_REGEXP">Partial regex</option>
                </select>
              </label>

              <label className="wideControl">
                Filter value
                <input name="filterValue" defaultValue={filterValue} placeholder="e.g. organic, /blog/, purchase" />
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
              <div><strong>Property</strong><span>{resource.display_name || resource.resource_id}</span></div>
              <div><strong>Period</strong><span>{startDate} → {endDate}</span></div>
              <div><strong>Preset</strong><span>{preset.label}</span></div>
            </section>
          ) : null}

          <section className="metricStrip">
            {metricHeaders.slice(0, 6).map((header, index) => (
              <article className="statCard" key={header.name || index}>
                <span>{header.name}</span>
                <strong>{formatValue(metricValue(totals, index), header.name)}</strong>
                <small>Selected period total</small>
              </article>
            ))}
            {!metricHeaders.length ? (
              <article className="statCard"><span>GA4 report</span><strong>—</strong><small>Run a valid report.</small></article>
            ) : null}
          </section>

          <div className="twoCol dataTwoCol">
            <section className="panel">
              <div className="panelHeader">
                <div><h2>{preset.label}</h2><p>{preset.description}</p></div>
              </div>

              {report?.rows?.length ? (
                <div className="dataTableWrap">
                  <table className="dataTable">
                    <thead>
                      <tr>
                        {dimensionHeaders.map((header, index) => <th key={header.name || index}>{header.name}</th>)}
                        {metricHeaders.map((header, index) => <th key={header.name || index}>{header.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {(row.dimensionValues || []).map((value, index) => (
                            <td key={index}><span className="cellEllipsis">{value.value || "—"}</span></td>
                          ))}
                          {(row.metricValues || []).map((value, index) => (
                            <td key={index}>{formatValue(value.value, metricHeaders[index]?.name)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="emptyState smallEmpty"><strong>No rows</strong><span>Run a report or adjust dimensions, metrics and filters.</span></div>
              )}
            </section>

            <aside className="sideStack">
              <section className="panel">
                <div className="panelHeader"><div><h2>Save this view</h2><p>Data Studio-style reusable configuration.</p></div></div>
                <form className="formPanel compactForm" action={saveGa4View.bind(null, id)}>
                  <input type="hidden" name="config" value={JSON.stringify(reportConfig)} />
                  <label>View name<input name="name" placeholder="e.g. Organic landing pages" required /></label>
                  <button className="secondaryButton" type="submit">Save GA4 view</button>
                </form>
              </section>

              <section className="panel">
                <div className="panelHeader"><div><h2>Saved GA4 views</h2><p>{savedViews?.length || 0} custom views.</p></div></div>
                {savedViews?.length ? (
                  <div className="savedViewList">
                    {savedViews.map((view) => (
                      <Link
                        key={view.id}
                        className="savedViewRow"
                        href={savedHref(id, "analytics", (view.config || {}) as Record<string, unknown>)}
                      >
                        <strong>{view.name}</strong><span>Open</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="emptyState smallEmpty"><span>No saved GA4 views yet.</span></div>
                )}
              </section>

              <section className="panel">
                <div className="panelHeader"><div><h2>Custom mode</h2><p>Use API names for dimensions and metrics.</p></div></div>
                <p className="muted">
                  Examples: landingPagePlusQueryString, sessionPrimaryChannelGroup, eventName · sessions, activeUsers, engagementRate, keyEvents, totalRevenue.
                </p>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <>
          <section className="panel explorerToolbar">
            <form method="get" className="funnelForm">
              <input type="hidden" name="mode" value="funnel" />
              <input type="hidden" name="run" value="1" />

              <div className="funnelToolbarRow">
                <label>Start<input type="date" name="start" defaultValue={startDate} /></label>
                <label>End<input type="date" name="end" defaultValue={endDate} /></label>
                <label>
                  Breakdown
                  <select name="breakdown" defaultValue={breakdownDimension}>
                    <option value="">No breakdown</option>
                    <option value="deviceCategory">Device</option>
                    <option value="country">Country</option>
                    <option value="platform">Platform</option>
                    <option value="sessionPrimaryChannelGroup">Channel group</option>
                  </select>
                </label>
                <label className="checkboxLabel">
                  <input type="checkbox" name="openFunnel" value="1" defaultChecked={isOpenFunnel} />
                  Open funnel
                </label>
              </div>

              <div className="funnelSteps">
                {[1, 2, 3, 4, 5].map((index) => {
                  const step = stepInputs[index - 1] || { name: "", eventName: "" };
                  return (
                    <div className="funnelStepCard" key={index}>
                      <span className="stepNumber">{index}</span>
                      <label>
                        Step name
                        <input
                          name={`step${index}Name`}
                          defaultValue={step.name}
                          placeholder={index === 1 ? "Visit" : index === 2 ? "Purchase" : "Optional step"}
                        />
                      </label>
                      <label>
                        Event name
                        <input
                          name={`step${index}Event`}
                          defaultValue={step.eventName}
                          placeholder={index === 1 ? "session_start" : index === 2 ? "purchase" : "event_name"}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>

              <button className="primaryButton" type="submit" disabled={!resource}>Run funnel</button>
            </form>
          </section>

          <div className="twoCol dataTwoCol">
            <section className="panel">
              <div className="panelHeader">
                <div>
                  <h2>Funnel result</h2>
                  <p>GA4 user journey by event sequence. Funnel API is currently an early-preview endpoint.</p>
                </div>
              </div>

              {funnel?.funnelTable?.rows?.length ? (
                <div className="dataTableWrap">
                  <table className="dataTable">
                    <thead>
                      <tr>
                        {(funnel.funnelTable.dimensionHeaders || []).map((header, index) => (
                          <th key={header.name || index}>{header.name}</th>
                        ))}
                        {(funnel.funnelTable.metricHeaders || []).map((header, index) => (
                          <th key={header.name || index}>{header.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {funnel.funnelTable.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {(row.dimensionValues || []).map((value, index) => (
                            <td key={index}><span className="cellEllipsis">{value.value || "—"}</span></td>
                          ))}
                          {(row.metricValues || []).map((value, index) => (
                            <td key={index}>{formatValue(value.value, funnel.funnelTable?.metricHeaders?.[index]?.name)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="emptyState smallEmpty"><strong>No funnel result</strong><span>Define at least two event steps and run the funnel.</span></div>
              )}
            </section>

            <aside className="sideStack">
              <section className="panel">
                <div className="panelHeader"><div><h2>Save funnel</h2><p>Keep recurring conversion journeys.</p></div></div>
                <form className="formPanel compactForm" action={saveGa4Funnel.bind(null, id)}>
                  <input type="hidden" name="config" value={JSON.stringify(funnelConfig)} />
                  <label>Funnel name<input name="name" placeholder="e.g. Organic → Store → Purchase" required /></label>
                  <button className="secondaryButton" type="submit">Save funnel</button>
                </form>
              </section>

              <section className="panel">
                <div className="panelHeader"><div><h2>Saved funnels</h2><p>{savedFunnels?.length || 0} funnel definitions.</p></div></div>
                {savedFunnels?.length ? (
                  <div className="savedViewList">
                    {savedFunnels.map((saved) => (
                      <Link
                        key={saved.id}
                        className="savedViewRow"
                        href={savedHref(id, "analytics", (saved.config || {}) as Record<string, unknown>)}
                      >
                        <strong>{saved.name}</strong><span>Open</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="emptyState smallEmpty"><span>No saved funnels yet.</span></div>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
