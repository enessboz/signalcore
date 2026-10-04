import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectDataNav } from "@/components/project-data-nav";
import { createClient } from "@/lib/supabase/server";
import {
  addTrackedKeywords,
  deleteTrackedKeyword,
  runRankCheck,
  saveRankTrackingSettings,
  seedFromGsc,
  updateTrackedKeyword,
} from "./actions";

export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
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

function formatPosition(value: number | null | undefined) {
  return value === null || value === undefined ? "Not found" : "#" + value;
}

function movement(
  current: number | null | undefined,
  previous: number | null | undefined,
) {
  if (current === null || current === undefined) {
    return previous !== null && previous !== undefined
      ? { label: "Lost from depth", className: "rankMoveDown" }
      : { label: "—", className: "" };
  }
  if (previous === null || previous === undefined) {
    return { label: "New #" + current, className: "rankMoveNew" };
  }
  const diff = previous - current;
  if (diff > 0) return { label: "↑ " + diff, className: "rankMoveUp" };
  if (diff < 0) return { label: "↓ " + Math.abs(diff), className: "rankMoveDown" };
  return { label: "—", className: "" };
}

export default async function RankTrackerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const selectedKeywordId = scalar(query.keyword);
  const supabase = await createClient();

  const [
    { data: project },
    { data: settings },
    { data: keywords },
    { data: recentHistory },
    { data: runs },
    { data: gscState },
    { data: usage },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,domain,project_type")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("rank_tracking_settings")
      .select("*")
      .eq("project_id", id)
      .maybeSingle(),
    supabase
      .from("tracked_keywords")
      .select("id,keyword,target_url,source,priority,cadence,depth,location_code,language_code,device,active,last_checked_at,last_position,last_ranking_url,last_status,last_error,consecutive_failures,created_at")
      .eq("project_id", id)
      .order("priority")
      .order("keyword")
      .limit(1000),
    supabase
      .from("rank_history")
      .select("id,tracked_keyword_id,checked_at,position,ranking_url,ranking_title,matched_domain,organic_result_count,serp_features,top_competitors,cost,metadata")
      .eq("project_id", id)
      .order("checked_at", { ascending: false })
      .limit(2500),
    supabase
      .from("rank_tracking_runs")
      .select("id,trigger_type,status,keywords_requested,keywords_completed,succeeded,failed,actual_cost,result,error,started_at,completed_at")
      .eq("project_id", id)
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("google_sync_states")
      .select("last_complete_date,last_success_at,status,last_error")
      .eq("project_id", id)
      .eq("source", "gsc")
      .eq("dataset", "query_daily")
      .maybeSingle(),
    supabase
      .from("usage_events")
      .select("actual_cost,estimated_cost,created_at")
      .eq("project_id", id)
      .eq("category", "serp")
      .gte(
        "created_at",
        new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
        ).toISOString(),
      ),
  ]);

  if (!project) notFound();

  const config = settings || {
    active: true,
    auto_discover_enabled: false,
    auto_findings_enabled: true,
    max_auto_keywords: 100,
    min_impressions_28d: 100,
    position_min: 1,
    position_max: 30,
    default_location_code: 2840,
    default_language_code: "en",
    default_device: "desktop",
    daily_high_priority_limit: 20,
    last_seeded_at: null,
    last_worker_run_at: null,
  };

  const historiesByKeyword = new Map<string, NonNullable<typeof recentHistory>>();
  for (const row of recentHistory || []) {
    const list = historiesByKeyword.get(row.tracked_keyword_id) || [];
    if (list.length < 30) list.push(row);
    historiesByKeyword.set(row.tracked_keyword_id, list);
  }

  const enriched = (keywords || []).map((keyword) => {
    const history = historiesByKeyword.get(keyword.id) || [];
    const latest = history[0] || null;
    const previous = history[1] || null;
    return {
      ...keyword,
      latest,
      previous,
      movement: movement(latest?.position, previous?.position),
    };
  });

  const activeKeywords = enriched.filter((item) => item.active);
  const top10 = activeKeywords.filter(
    (item) => item.last_position !== null && Number(item.last_position) <= 10,
  ).length;
  const top3 = activeKeywords.filter(
    (item) => item.last_position !== null && Number(item.last_position) <= 3,
  ).length;
  const notFoundCount = activeKeywords.filter(
    (item) => item.last_checked_at && item.last_position === null,
  ).length;
  const winners = enriched.filter(
    (item) =>
      item.latest?.position !== null &&
      item.latest?.position !== undefined &&
      item.previous?.position !== null &&
      item.previous?.position !== undefined &&
      Number(item.latest.position) < Number(item.previous.position),
  ).length;
  const losers = enriched.filter(
    (item) =>
      item.latest?.position !== null &&
      item.latest?.position !== undefined &&
      item.previous?.position !== null &&
      item.previous?.position !== undefined &&
      Number(item.latest.position) > Number(item.previous.position),
  ).length;
  const monthSpend = (usage || []).reduce(
    (sum, item) =>
      sum + Number(item.actual_cost ?? item.estimated_cost ?? 0),
    0,
  );
  const selectedKeyword =
    enriched.find((item) => item.id === selectedKeywordId) || null;
  const selectedHistory = selectedKeyword
    ? historiesByKeyword.get(selectedKeyword.id) || []
    : [];

  const dataForSeoReady = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Exact SERP monitoring</p>
          <h1>{project.name} · Rank Tracker</h1>
          <p className="muted">
            Track exact Google positions by location and device. GSC remains the
            first-party visibility source; rank checks provide controlled SERP snapshots.
          </p>
        </div>
        <div className="buttonRow">
          <span className={dataForSeoReady ? "readinessBadge readinessReady" : "readinessBadge readinessOptional"}>
            DataForSEO {dataForSeoReady ? "ready" : "waiting"}
          </span>
          <Link href={"/projects/" + id} className="ghostButton">
            Back to project
          </Link>
        </div>
      </header>

      <ProjectDataNav projectId={id} active="rank" />

      {scalar(query.error) ? (
        <p className="formMessage formError pageMessage">{scalar(query.error)}</p>
      ) : null}
      {scalar(query.message) ? (
        <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p>
      ) : null}

      <section className="healthGrid rankHealthGrid">
        <article className="healthCard">
          <span>Active keywords</span>
          <strong>{activeKeywords.length}</strong>
          <small>{enriched.length} total saved</small>
        </article>
        <article className="healthCard">
          <span>Top 3</span>
          <strong>{top3}</strong>
          <small>{top10} in top 10</small>
        </article>
        <article className="healthCard">
          <span>Winners / losers</span>
          <strong>{winners} / {losers}</strong>
          <small>Latest check vs previous</small>
        </article>
        <article className="healthCard">
          <span>Not found</span>
          <strong>{notFoundCount}</strong>
          <small>Outside configured monitored depth</small>
        </article>
        <article className="healthCard">
          <span>SERP spend this month</span>
          <strong>{"$" + monthSpend.toFixed(4)}</strong>
          <small>Rank + manual SERP research</small>
        </article>
        <article className="healthCard">
          <span>GSC warehouse</span>
          <strong>{gscState?.last_complete_date || "—"}</strong>
          <small>{gscState?.status || "not synced"}</small>
        </article>
      </section>

      <div className="twoCol rankSetupGrid">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Automation & GSC discovery</h2>
              <p>
                SignalCore can select high-signal GSC queries automatically and
                assign cost-aware daily/weekly tracking.
              </p>
            </div>
          </div>

          <form
            className="formPanel"
            action={saveRankTrackingSettings.bind(null, id)}
          >
            <div className="formGrid2">
              <label className="checkboxLabel">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={Boolean(config.active)}
                />
                Background rank tracking active
              </label>
              <label className="checkboxLabel">
                <input
                  name="autoDiscover"
                  type="checkbox"
                  defaultChecked={Boolean(config.auto_discover_enabled)}
                />
                Auto-discover keywords from GSC
              </label>
              <label className="checkboxLabel">
                <input
                  name="autoFindings"
                  type="checkbox"
                  defaultChecked={Boolean(config.auto_findings_enabled)}
                />
                Create rank change findings
              </label>
              <label>
                Max auto keywords
                <input
                  name="maxAutoKeywords"
                  type="number"
                  min="0"
                  max="1000"
                  defaultValue={config.max_auto_keywords}
                />
              </label>
              <label>
                Min 28-day impressions
                <input
                  name="minImpressions"
                  type="number"
                  min="0"
                  defaultValue={config.min_impressions_28d}
                />
              </label>
              <label>
                GSC position range
                <div className="inlineInputPair">
                  <input
                    name="positionMin"
                    type="number"
                    step="0.1"
                    min="0"
                    defaultValue={config.position_min}
                  />
                  <input
                    name="positionMax"
                    type="number"
                    step="0.1"
                    min="0"
                    defaultValue={config.position_max}
                  />
                </div>
              </label>
              <label>
                Default location code
                <input
                  name="locationCode"
                  type="number"
                  defaultValue={config.default_location_code}
                />
              </label>
              <label>
                Language
                <input
                  name="languageCode"
                  defaultValue={config.default_language_code}
                />
              </label>
              <label>
                Device
                <select name="device" defaultValue={config.default_device}>
                  <option value="desktop">Desktop</option>
                  <option value="mobile">Mobile</option>
                </select>
              </label>
              <label>
                Daily high-priority limit
                <input
                  name="dailyHighPriorityLimit"
                  type="number"
                  min="0"
                  max="200"
                  defaultValue={config.daily_high_priority_limit}
                />
              </label>
            </div>

            <div className="buttonRow">
              <button className="primaryButton" type="submit">
                Save settings
              </button>
              <button
                className="secondaryButton"
                formAction={seedFromGsc.bind(null, id)}
                type="submit"
                disabled={!gscState?.last_complete_date}
              >
                Seed from GSC now
              </button>
            </div>

            <p className="muted">
              Last GSC seed:{" "}
              {config.last_seeded_at
                ? new Date(config.last_seeded_at).toLocaleString("en-GB")
                : "never"}.
              High-priority auto keywords are daily; remaining candidates are weekly.
            </p>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Add tracked keywords</h2>
              <p>Manual keywords remain explicit and are not removed by GSC auto-discovery.</p>
            </div>
          </div>

          <form
            className="formPanel"
            action={addTrackedKeywords.bind(null, id)}
          >
            <label>
              Keywords · one per line
              <textarea
                name="keywords"
                rows={8}
                required
                placeholder={"best calorie tracker\ncalorie deficit calculator\nhow many calories should i eat"}
              />
            </label>
            <label>
              Target URL · optional
              <input name="targetUrl" placeholder="https://example.com/page/" />
            </label>
            <div className="formGrid2">
              <label>
                Priority
                <select name="priority" defaultValue="normal">
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
              </label>
              <label>
                Cadence
                <select name="cadence" defaultValue="weekly">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                SERP depth
                <select name="depth" defaultValue="30">
                  <option value="10">Top 10</option>
                  <option value="20">Top 20</option>
                  <option value="30">Top 30</option>
                  <option value="50">Top 50</option>
                  <option value="100">Top 100</option>
                </select>
              </label>
              <label>
                Location code
                <input
                  name="locationCode"
                  type="number"
                  defaultValue={config.default_location_code}
                />
              </label>
              <label>
                Language
                <input
                  name="languageCode"
                  defaultValue={config.default_language_code}
                />
              </label>
              <label>
                Device
                <select name="device" defaultValue={config.default_device}>
                  <option value="desktop">Desktop</option>
                  <option value="mobile">Mobile</option>
                </select>
              </label>
            </div>
            <button className="primaryButton" type="submit">
              Add keywords
            </button>
          </form>
        </section>
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Tracked keywords</h2>
            <p>
              Position is an exact configured SERP snapshot. “Not found” means the
              project domain did not appear inside that keyword’s monitored depth.
            </p>
          </div>
          <form action={runRankCheck.bind(null, id, undefined)}>
            <button
              className="primaryButton"
              type="submit"
              disabled={!dataForSeoReady || !activeKeywords.length}
            >
              Check next 10 now
            </button>
          </form>
        </div>

        {enriched.length ? (
          <div className="rankKeywordList">
            {enriched.map((keyword) => (
              <article
                className={keyword.active ? "rankKeywordCard" : "rankKeywordCard inactive"}
                key={keyword.id}
              >
                <div className="rankKeywordHeader">
                  <div>
                    <p className="eyebrow">
                      {keyword.source.replaceAll("_", " ")} · {keyword.device} ·{" "}
                      {keyword.location_code}
                    </p>
                    <h3>{keyword.keyword}</h3>
                  </div>
                  <div className="rankPositionBlock">
                    <strong>{formatPosition(keyword.last_position)}</strong>
                    <span className={keyword.movement.className}>
                      {keyword.movement.label}
                    </span>
                  </div>
                </div>

                <div className="rankKeywordMeta">
                  <div>
                    <strong>Ranking URL</strong>
                    <span>{compactUrl(keyword.last_ranking_url)}</span>
                  </div>
                  <div>
                    <strong>Cadence</strong>
                    <span>{keyword.cadence} · top {keyword.depth}</span>
                  </div>
                  <div>
                    <strong>Last check</strong>
                    <span>
                      {keyword.last_checked_at
                        ? new Date(keyword.last_checked_at).toLocaleString("en-GB")
                        : "Never"}
                    </span>
                  </div>
                  <div>
                    <strong>Status</strong>
                    <span>{keyword.last_status}</span>
                  </div>
                </div>

                {keyword.last_error ? (
                  <p className="formMessage formError">{keyword.last_error}</p>
                ) : null}

                <form
                  className="rankKeywordControls"
                  action={updateTrackedKeyword.bind(null, id, keyword.id)}
                >
                  <label>
                    Priority
                    <select name="priority" defaultValue={keyword.priority}>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  </label>
                  <label>
                    Cadence
                    <select name="cadence" defaultValue={keyword.cadence}>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </label>
                  <label>
                    Depth
                    <select name="depth" defaultValue={String(keyword.depth)}>
                      <option value="10">10</option>
                      <option value="20">20</option>
                      <option value="30">30</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                    </select>
                  </label>
                  <label>
                    Target URL
                    <input
                      name="targetUrl"
                      defaultValue={keyword.target_url || ""}
                      placeholder="Optional"
                    />
                  </label>
                  <label className="checkboxLabel">
                    <input
                      name="active"
                      type="checkbox"
                      defaultChecked={keyword.active}
                    />
                    Active
                  </label>
                  <button className="ghostButton" type="submit">
                    Save
                  </button>
                </form>

                <div className="buttonRow">
                  <form action={runRankCheck.bind(null, id, keyword.id)}>
                    <button
                      className="secondaryButton"
                      type="submit"
                      disabled={!dataForSeoReady}
                    >
                      Check now
                    </button>
                  </form>
                  <Link
                    className="ghostButton"
                    href={"/projects/" + id + "/rank-tracker?keyword=" + keyword.id}
                  >
                    History
                  </Link>
                  <form action={deleteTrackedKeyword.bind(null, id, keyword.id)}>
                    <button className="ghostButton" type="submit">
                      Remove
                    </button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="emptyState">
            <strong>No tracked keywords yet</strong>
            <span>Add keywords manually or seed a cost-controlled set from the GSC warehouse.</span>
          </div>
        )}
      </section>

      {selectedKeyword ? (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Position history</p>
              <h2>{selectedKeyword.keyword}</h2>
              <p>
                {selectedKeyword.device} · location {selectedKeyword.location_code} ·{" "}
                {selectedKeyword.language_code} · depth {selectedKeyword.depth}
              </p>
            </div>
            <Link className="ghostButton" href={"/projects/" + id + "/rank-tracker"}>
              Close history
            </Link>
          </div>

          {selectedHistory.length ? (
            <div className="dataTableWrap">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>Checked</th>
                    <th>Position</th>
                    <th>Ranking URL</th>
                    <th>Results</th>
                    <th>Features</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedHistory.map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.checked_at).toLocaleString("en-GB")}</td>
                      <td>{formatPosition(row.position)}</td>
                      <td>
                        <span className="cellEllipsis">
                          {compactUrl(row.ranking_url)}
                        </span>
                      </td>
                      <td>{row.organic_result_count}</td>
                      <td>
                        {Array.isArray(row.serp_features)
                          ? row.serp_features.slice(0, 4).join(", ") || "—"
                          : "—"}
                      </td>
                      <td>{"$" + Number(row.cost || 0).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="emptyState smallEmpty">
              <span>No rank history yet.</span>
            </div>
          )}
        </section>
      ) : null}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Recent rank runs</h2>
            <p>Manual and background batches with recorded provider cost.</p>
          </div>
        </div>
        {(runs || []).length ? (
          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Completed</th>
                  <th>Succeeded</th>
                  <th>Failed</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {(runs || []).map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.started_at).toLocaleString("en-GB")}</td>
                    <td>{run.trigger_type}</td>
                    <td>
                      <span className={"jobStatus job-" + run.status}>
                        {run.status}
                      </span>
                    </td>
                    <td>{run.keywords_completed}/{run.keywords_requested}</td>
                    <td>{run.succeeded}</td>
                    <td>{run.failed}</td>
                    <td>{"$" + Number(run.actual_cost || 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState smallEmpty">
            <span>No rank tracking runs yet.</span>
          </div>
        )}
      </section>
    </div>
  );
}
