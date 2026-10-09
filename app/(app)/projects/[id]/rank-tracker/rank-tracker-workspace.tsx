"use client";

import { useMemo, useState } from "react";

type Action = (formData: FormData) => void | Promise<void>;

type TrendPoint = {
  date: string;
  avgPosition: number;
  visibility: number;
  checked: number;
};

type KeywordRow = {
  id: string;
  keyword: string;
  targetUrl: string | null;
  source: string;
  priority: string;
  cadence: string;
  depth: number;
  locationCode: number;
  languageCode: string;
  device: string;
  active: boolean;
  lastCheckedAt: string | null;
  lastPosition: number | null;
  lastRankingUrl: string | null;
  lastStatus: string;
  lastError: string | null;
  latestPosition: number | null;
  previousPosition: number | null;
  bestPosition: number | null;
  gscClicks: number;
  gscImpressions: number;
  gscCtr: number;
  groups: Array<{ id: string; name: string; color: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
};

type GroupCard = {
  id: string;
  name: string;
  source: string;
  metric: string | null;
  windowDays: number;
  keywordLimit: number;
  count: number;
  lastStatus: string;
  lastDataDate: string | null;
  autoRefreshEnabled: boolean;
  refreshCadence: string;
};

type TagCard = {
  id: string;
  name: string;
  color: string;
  count: number;
};

type LandingPage = {
  url: string;
  keywordCount: number;
  avgPosition: number | null;
  top10: number;
  clicks: number;
  impressions: number;
};

type Competitor = {
  domain: string;
  appearances: number;
  avgRank: number;
};

type SerpFeature = {
  name: string;
  count: number;
};

type Settings = {
  active: boolean;
  auto_discover_enabled: boolean;
  auto_findings_enabled: boolean;
  max_auto_keywords: number;
  min_impressions_28d: number;
  position_min: number;
  position_max: number;
  default_location_code: number;
  default_language_code: string;
  default_device: string;
  daily_high_priority_limit: number;
  last_seeded_at: string | null;
  last_worker_run_at: string | null;
};

type Props = {
  project: { id: string; name: string; domain: string | null };
  locale: "tr" | "en";
  dataForSeoReady: boolean;
  settings: Settings;
  keywords: KeywordRow[];
  trend: TrendPoint[];
  groups: GroupCard[];
  tags: TagCard[];
  landingPages: LandingPage[];
  competitors: Competitor[];
  serpFeatures: SerpFeature[];
  monthSpend: number;
  gscLastDate: string | null;
  gscStatus: string | null;
  actions: {
    runRankCheck: Action;
    saveSettings: Action;
    addKeywords: Action;
    seedFromGsc: Action;
    createTag: Action;
    assignTag: Action;
    deleteTag: Action;
  };
};

const countryMap: Record<number, { code: string; name: string; flag: string }> = {
  2840: { code: "US", name: "United States", flag: "🇺🇸" },
  2826: { code: "GB", name: "United Kingdom", flag: "🇬🇧" },
  2792: { code: "TR", name: "Türkiye", flag: "🇹🇷" },
  2276: { code: "DE", name: "Germany", flag: "🇩🇪" },
  2250: { code: "FR", name: "France", flag: "🇫🇷" },
  2724: { code: "ES", name: "Spain", flag: "🇪🇸" },
  2380: { code: "IT", name: "Italy", flag: "🇮🇹" },
  2124: { code: "CA", name: "Canada", flag: "🇨🇦" },
  2036: { code: "AU", name: "Australia", flag: "🇦🇺" },
};

function locationInfo(code: number) {
  return countryMap[code] || {
    code: String(code),
    name: "Location " + String(code),
    flag: "🌐",
  };
}

function positionDelta(current: number | null, previous: number | null) {
  if (current === null && previous === null) return 0;
  if (current !== null && previous === null) return 0;
  if (current === null && previous !== null) return -100;
  return Number(previous || 0) - Number(current || 0);
}

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function sparkline(history: TrendPoint[]) {
  if (!history.length) return "";
  const values = history.map((item) => item.visibility);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  return history
    .map((item, index) => {
      const x = history.length === 1 ? 50 : (index / (history.length - 1)) * 100;
      const y = 92 - ((item.visibility - min) / range) * 74;
      return `${index ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function RankTrackerWorkspace(props: Props) {
  const tr = props.locale === "tr";
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("all");
  const [device, setDevice] = useState("all");
  const [segment, setSegment] = useState("all");
  const [positionBand, setPositionBand] = useState("all");
  const [quick, setQuick] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  const activeKeywords = useMemo(
    () => props.keywords.filter((item) => item.active),
    [props.keywords],
  );

  const summary = useMemo(() => {
    const ranked = activeKeywords.filter((item) => item.lastPosition !== null);
    const avgPosition = ranked.length
      ? ranked.reduce((sum, item) => sum + Number(item.lastPosition), 0) /
        ranked.length
      : 0;
    const top3 = ranked.filter((item) => Number(item.lastPosition) <= 3).length;
    const top10 = ranked.filter((item) => Number(item.lastPosition) <= 10).length;
    const top20 = ranked.filter((item) => Number(item.lastPosition) <= 20).length;
    const improved = activeKeywords.filter(
      (item) => positionDelta(item.latestPosition, item.previousPosition) > 0,
    ).length;
    const declined = activeKeywords.filter(
      (item) => positionDelta(item.latestPosition, item.previousPosition) < 0,
    ).length;
    const clicks = activeKeywords.reduce((sum, item) => sum + item.gscClicks, 0);
    const impressions = activeKeywords.reduce(
      (sum, item) => sum + item.gscImpressions,
      0,
    );
    const visibility = props.trend.length
      ? props.trend[props.trend.length - 1]!.visibility
      : ranked.length
        ? ranked.reduce(
            (sum, item) =>
              sum +
              Math.max(0, 1 - (Number(item.lastPosition || 100) - 1) / 100),
            0,
          ) /
          ranked.length *
          100
        : 0;

    return {
      avgPosition,
      top3,
      top10,
      top20,
      improved,
      declined,
      clicks,
      impressions,
      visibility,
    };
  }, [activeKeywords, props.trend]);

  const countries = useMemo(() => {
    const map = new Map<
      number,
      {
        locationCode: number;
        count: number;
        ranked: number;
        positionSum: number;
        top10: number;
        improved: number;
        declined: number;
      }
    >();

    for (const item of activeKeywords) {
      const current = map.get(item.locationCode) || {
        locationCode: item.locationCode,
        count: 0,
        ranked: 0,
        positionSum: 0,
        top10: 0,
        improved: 0,
        declined: 0,
      };
      current.count += 1;
      if (item.lastPosition !== null) {
        current.ranked += 1;
        current.positionSum += Number(item.lastPosition);
        if (Number(item.lastPosition) <= 10) current.top10 += 1;
      }
      const delta = positionDelta(item.latestPosition, item.previousPosition);
      if (delta > 0) current.improved += 1;
      if (delta < 0) current.declined += 1;
      map.set(item.locationCode, current);
    }

    return Array.from(map.values())
      .map((item) => ({
        ...item,
        ...locationInfo(item.locationCode),
        avgPosition: item.ranked ? item.positionSum / item.ranked : null,
      }))
      .sort((a, b) => b.count - a.count);
  }, [activeKeywords]);

  const allSegments = useMemo(() => {
    const items: Array<{ id: string; name: string; type: "group" | "tag" }> = [];
    for (const group of props.groups) {
      items.push({ id: group.id, name: group.name, type: "group" });
    }
    for (const tag of props.tags) {
      items.push({ id: tag.id, name: tag.name, type: "tag" });
    }
    return items;
  }, [props.groups, props.tags]);

  const filteredKeywords = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("en-US");
    return props.keywords.filter((item) => {
      if (q) {
        const haystack = [
          item.keyword,
          item.targetUrl || "",
          item.lastRankingUrl || "",
          ...item.groups.map((group) => group.name),
          ...item.tags.map((tag) => tag.name),
        ]
          .join(" ")
          .toLocaleLowerCase("en-US");
        if (!haystack.includes(q)) return false;
      }

      if (country !== "all" && String(item.locationCode) !== country) return false;
      if (device !== "all" && item.device !== device) return false;

      if (segment !== "all") {
        const [type, id] = segment.split(":");
        if (
          type === "group" &&
          !item.groups.some((group) => group.id === id)
        ) {
          return false;
        }
        if (type === "tag" && !item.tags.some((tag) => tag.id === id)) {
          return false;
        }
      }

      const pos = item.lastPosition;
      if (positionBand === "top3" && (pos === null || pos > 3)) return false;
      if (positionBand === "top10" && (pos === null || pos > 10)) return false;
      if (positionBand === "top20" && (pos === null || pos > 20)) return false;
      if (positionBand === "21plus" && (pos === null || pos <= 20)) return false;
      if (positionBand === "unranked" && pos !== null) return false;

      const delta = positionDelta(item.latestPosition, item.previousPosition);
      if (quick === "winners" && delta <= 0) return false;
      if (quick === "losers" && delta >= 0) return false;
      if (quick === "top10" && (pos === null || pos > 10)) return false;
      if (
        quick === "attention" &&
        !(
          item.lastStatus === "failed" ||
          item.lastStatus === "paused" ||
          pos === null ||
          delta <= -3
        )
      ) {
        return false;
      }

      return true;
    });
  }, [props.keywords, search, country, device, segment, positionBand, quick]);

  const alerts = useMemo(
    () =>
      props.keywords
        .map((item) => ({
          ...item,
          delta: positionDelta(item.latestPosition, item.previousPosition),
        }))
        .filter(
          (item) =>
            item.lastStatus === "failed" ||
            item.lastStatus === "paused" ||
            item.lastPosition === null ||
            item.delta <= -3,
        )
        .sort((a, b) => a.delta - b.delta)
        .slice(0, 50),
    [props.keywords],
  );

  const selectAllVisible = () => {
    const ids = filteredKeywords.map((item) => item.id);
    setSelectedIds((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : Array.from(new Set([...current, ...ids])),
    );
  };

  const exportCsv = () => {
    const header = [
      "Keyword",
      "Ranking URL",
      "Country",
      "Device",
      "Position",
      "Previous Position",
      "Best Position",
      "GSC Clicks",
      "GSC Impressions",
      "GSC CTR",
      "Groups",
      "Tags",
      "Status",
      "Last Checked",
    ];
    const lines = [
      header,
      ...filteredKeywords.map((item) => [
        item.keyword,
        item.lastRankingUrl || item.targetUrl || "",
        locationInfo(item.locationCode).name,
        item.device,
        item.lastPosition ?? "",
        item.previousPosition ?? "",
        item.bestPosition ?? "",
        item.gscClicks,
        item.gscImpressions,
        item.gscCtr.toFixed(4),
        item.groups.map((group) => group.name).join(" | "),
        item.tags.map((tag) => tag.name).join(" | "),
        item.lastStatus,
        item.lastCheckedAt || "",
      ]),
    ];
    downloadFile(
      props.project.name.toLowerCase().replaceAll(" ", "-") +
        "-rank-tracker.csv",
      lines.map((line) => line.map(csvEscape).join(",")).join("\n"),
      "text/csv;charset=utf-8",
    );
  };

  const exportJson = () => {
    downloadFile(
      props.project.name.toLowerCase().replaceAll(" ", "-") +
        "-rank-tracker.json",
      JSON.stringify(filteredKeywords, null, 2),
      "application/json",
    );
  };

  const navItems = [
    ["overview", tr ? "Genel Bakış" : "Overview"],
    ["keywords", tr ? "Keywordler" : "Keywords"],
    ["segments", tr ? "Gruplar & Tagler" : "Groups & Tags"],
    ["countries", tr ? "Ülkeler" : "Countries"],
    ["landing", tr ? "Landing Pages" : "Landing Pages"],
    ["competitors", tr ? "Rakipler" : "Competitors"],
    ["alerts", tr ? "Uyarılar" : "Alerts"],
    ["settings", tr ? "Ayarlar" : "Settings"],
  ];

  const visibilityPath = sparkline(props.trend);

  return (
    <div className="rankWorkspace">
      <div className="rankWorkspaceHero">
        <div>
          <p className="eyebrow">SignalCore · Rank Tracker</p>
          <h1>{props.project.name}</h1>
          <p>
            {tr
              ? "Organik görünürlüğü, ülke bazlı sıralamaları, keyword gruplarını ve değişimleri tek çalışma alanında izleyin."
              : "Track organic visibility, country rankings, keyword groups and movement in one workspace."}
          </p>
        </div>
        <div className="rankWorkspaceHeroActions">
          <span
            className={
              props.dataForSeoReady
                ? "readinessBadge readinessReady"
                : "readinessBadge readinessOptional"
            }
          >
            DataForSEO {props.dataForSeoReady ? "ready" : "waiting"}
          </span>
          <span className="rankWorkspaceDataBadge">
            GSC {props.gscStatus || "—"} · {props.gscLastDate || "—"}
          </span>
          <form action={props.actions.runRankCheck}>
            <button className="secondaryButton" type="submit">
              {tr ? "Şimdi Kontrol Et" : "Run Rank Check"}
            </button>
          </form>
          <button className="primaryButton" type="button" onClick={exportCsv}>
            ⇩ {tr ? "Export" : "Export"}
          </button>
        </div>
      </div>

      <nav className="rankWorkspaceNav" aria-label="Rank Tracker sections">
        {navItems.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "alerts" && alerts.length ? (
              <span>{alerts.length}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <>
          <section className="rankWorkspaceKpis">
            <article>
              <span>{tr ? "Visibility Score" : "Visibility Score"}</span>
              <strong>{summary.visibility.toFixed(1)}%</strong>
              <small>
                {props.trend.length
                  ? tr
                    ? "Rank history tabanlı"
                    : "Based on rank history"
                  : tr
                    ? "Mevcut pozisyonlardan"
                    : "From current positions"}
              </small>
            </article>
            <article>
              <span>{tr ? "Ortalama Pozisyon" : "Average Position"}</span>
              <strong>{summary.avgPosition ? summary.avgPosition.toFixed(1) : "—"}</strong>
              <small>{activeKeywords.length} active keywords</small>
            </article>
            <article>
              <span>Top 3</span>
              <strong>{summary.top3}</strong>
              <small>{pct(summary.top3, activeKeywords.length)}%</small>
            </article>
            <article>
              <span>Top 10</span>
              <strong>{summary.top10}</strong>
              <small>{pct(summary.top10, activeKeywords.length)}%</small>
            </article>
            <article>
              <span>Top 20</span>
              <strong>{summary.top20}</strong>
              <small>{pct(summary.top20, activeKeywords.length)}%</small>
            </article>
            <article>
              <span>{tr ? "Yükselen" : "Improved"}</span>
              <strong className="rankGood">{summary.improved}</strong>
              <small>{tr ? "son iki kontrol" : "latest vs previous"}</small>
            </article>
            <article>
              <span>{tr ? "Düşen" : "Declined"}</span>
              <strong className="rankBad">{summary.declined}</strong>
              <small>{tr ? "dikkat gerektirir" : "needs review"}</small>
            </article>
            <article>
              <span>GSC Clicks</span>
              <strong>{summary.clicks.toLocaleString()}</strong>
              <small>{summary.impressions.toLocaleString()} impressions</small>
            </article>
          </section>

          <div className="rankWorkspaceOverviewGrid">
            <section className="panel rankWorkspaceChartPanel">
              <div className="panelHeader">
                <div>
                  <h2>{tr ? "Visibility Trend" : "Visibility Trend"}</h2>
                  <p>{tr ? "Rank history üzerinden görünürlük trendi" : "Visibility trend from rank history"}</p>
                </div>
                <div className="rankChartLegend">
                  <span><i className="rankLegendPurple" />Visibility</span>
                  <span><i className="rankLegendGreen" />Avg. position</span>
                </div>
              </div>
              <div className="rankTrendChart">
                {props.trend.length ? (
                  <>
                    <div className="rankChartGrid">
                      <span /><span /><span /><span />
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="rankFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#665ce9" stopOpacity=".24" />
                          <stop offset="100%" stopColor="#665ce9" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path
                        d={visibilityPath + " L 100 100 L 0 100 Z"}
                        fill="url(#rankFill)"
                      />
                      <path
                        d={visibilityPath}
                        fill="none"
                        stroke="#665ce9"
                        strokeWidth="2.2"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                    <div className="rankTrendLabels">
                      {props.trend
                        .filter(
                          (_, index) =>
                            index === 0 ||
                            index === props.trend.length - 1 ||
                            index % Math.max(Math.floor(props.trend.length / 4), 1) === 0,
                        )
                        .slice(0, 6)
                        .map((item) => (
                          <span key={item.date}>
                            {new Date(item.date + "T00:00:00Z").toLocaleDateString(
                              tr ? "tr-TR" : "en-GB",
                              { day: "2-digit", month: "short" },
                            )}
                          </span>
                        ))}
                    </div>
                  </>
                ) : (
                  <div className="rankEmptyChart">
                    {tr
                      ? "Trend grafiği ilk rank kontrolleri geldikçe oluşacak."
                      : "Trend chart will appear as rank checks accumulate."}
                  </div>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panelHeader">
                <div>
                  <h2>{tr ? "Ranking Distribution" : "Ranking Distribution"}</h2>
                  <p>{tr ? "Aktif keyword pozisyon dağılımı" : "Active keyword position distribution"}</p>
                </div>
              </div>
              <div className="rankDistribution">
                {[
                  ["Top 3", summary.top3, "purple"],
                  ["Top 10", summary.top10, "green"],
                  ["11–20", Math.max(summary.top20 - summary.top10, 0), "blue"],
                  [
                    "21–50",
                    activeKeywords.filter(
                      (item) =>
                        item.lastPosition !== null &&
                        item.lastPosition > 20 &&
                        item.lastPosition <= 50,
                    ).length,
                    "amber",
                  ],
                  [
                    "51+",
                    activeKeywords.filter(
                      (item) => item.lastPosition !== null && item.lastPosition > 50,
                    ).length,
                    "gray",
                  ],
                ].map(([label, count, color]) => (
                  <div className="rankDistributionRow" key={String(label)}>
                    <strong>{label}</strong>
                    <div className={"rankDistributionBar " + color}>
                      <span
                        style={{
                          width:
                            Math.max(
                              pct(Number(count), activeKeywords.length),
                              Number(count) ? 3 : 0,
                            ) + "%",
                        }}
                      />
                    </div>
                    <b>{count}</b>
                  </div>
                ))}
                <div className="rankDistributionMini">
                  <div><b className="rankGood">+{summary.improved}</b><span>Improved</span></div>
                  <div><b className="rankBad">-{summary.declined}</b><span>Declined</span></div>
                  <div><b>{alerts.length}</b><span>Alerts</span></div>
                  <div><b>{"$" + props.monthSpend.toFixed(3)}</b><span>SERP spend</span></div>
                </div>
              </div>
            </section>
          </div>

          <section className="panel rankCountryPanel">
            <div className="panelHeader">
              <div>
                <h2>{tr ? "Ülke Performansı" : "Country Performance"}</h2>
                <p>{tr ? "Takip konumlarına göre gerçek ranking özeti" : "Actual ranking summary by tracked locations"}</p>
              </div>
              <button className="ghostButton" type="button" onClick={() => setTab("countries")}>
                {tr ? "Detayları aç" : "Open details"} →
              </button>
            </div>
            <div className="rankCountryGrid">
              {countries.length ? (
                countries.slice(0, 6).map((item) => (
                  <button
                    key={item.locationCode}
                    type="button"
                    className="rankCountryCard"
                    onClick={() => {
                      setCountry(String(item.locationCode));
                      setTab("keywords");
                    }}
                  >
                    <div>
                      <span className="rankCountryFlag">{item.flag}</span>
                      <strong>{item.name}</strong>
                    </div>
                    <b>
                      {item.avgPosition === null ? "—" : item.avgPosition.toFixed(1)}
                    </b>
                    <small>
                      {item.top10} Top 10 · {item.count} keywords
                    </small>
                  </button>
                ))
              ) : (
                <div className="emptyState">
                  <strong>{tr ? "Henüz ülke verisi yok" : "No country data yet"}</strong>
                </div>
              )}
            </div>
          </section>

          <section className="panel rankSegmentPanel">
            <div className="panelHeader">
              <div>
                <h2>{tr ? "Gruplar & Tagler" : "Groups & Tags"}</h2>
                <p>{tr ? "Dinamik GSC grupları ve manuel segmentler" : "Dynamic GSC groups and manual segments"}</p>
              </div>
              <button className="secondaryButton" type="button" onClick={() => setTagManagerOpen(true)}>
                # {tr ? "Tag Yönetimi" : "Manage Tags"}
              </button>
            </div>
            <div className="rankSegmentGrid">
              {props.groups.slice(0, 6).map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="rankSegmentCard"
                  onClick={() => {
                    setSegment("group:" + group.id);
                    setTab("keywords");
                  }}
                >
                  <div className="rankSegmentCardTop">
                    <span className="rankSegmentType">Dynamic Group</span>
                    <span>{group.count} KW</span>
                  </div>
                  <strong>{group.name}</strong>
                  <div className="rankSegmentStats">
                    <div><b>{group.windowDays}d</b><span>GSC window</span></div>
                    <div><b>{group.lastStatus}</b><span>status</span></div>
                  </div>
                </button>
              ))}
              {props.tags.slice(0, 6).map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="rankSegmentCard"
                  onClick={() => {
                    setSegment("tag:" + tag.id);
                    setTab("keywords");
                  }}
                >
                  <div className="rankSegmentCardTop">
                    <span className={"rankTag rankTag-" + tag.color}>Manual Tag</span>
                    <span>{tag.count} KW</span>
                  </div>
                  <strong>{tag.name}</strong>
                  <div className="rankSegmentStats">
                    <div><b>{tag.count}</b><span>keywords</span></div>
                    <div><b>Manual</b><span>source</span></div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {tab === "keywords" ? (
        <KeywordTable
          tr={tr}
          projectId={props.project.id}
          keywords={props.keywords}
          filteredKeywords={filteredKeywords}
          groups={props.groups}
          tags={props.tags}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          selectAllVisible={selectAllVisible}
          search={search}
          setSearch={setSearch}
          country={country}
          setCountry={setCountry}
          device={device}
          setDevice={setDevice}
          segment={segment}
          setSegment={setSegment}
          positionBand={positionBand}
          setPositionBand={setPositionBand}
          quick={quick}
          setQuick={setQuick}
          allSegments={allSegments}
          countries={countries}
          exportCsv={exportCsv}
          exportJson={exportJson}
          assignTagAction={props.actions.assignTag}
          runRankCheckAction={props.actions.runRankCheck}
          openTagManager={() => setTagManagerOpen(true)}
        />
      ) : null}

      {tab === "segments" ? (
        <SegmentsView
          tr={tr}
          groups={props.groups}
          tags={props.tags}
          openTagManager={() => setTagManagerOpen(true)}
          onOpenGroup={(id) => {
            setSegment("group:" + id);
            setTab("keywords");
          }}
          onOpenTag={(id) => {
            setSegment("tag:" + id);
            setTab("keywords");
          }}
        />
      ) : null}

      {tab === "countries" ? (
        <CountriesView
          tr={tr}
          countries={countries}
          onOpen={(code) => {
            setCountry(String(code));
            setTab("keywords");
          }}
        />
      ) : null}

      {tab === "landing" ? (
        <LandingPagesView tr={tr} pages={props.landingPages} />
      ) : null}

      {tab === "competitors" ? (
        <CompetitorsView
          tr={tr}
          competitors={props.competitors}
          serpFeatures={props.serpFeatures}
        />
      ) : null}

      {tab === "alerts" ? (
        <AlertsView
          tr={tr}
          alerts={alerts}
          runRankCheckAction={props.actions.runRankCheck}
        />
      ) : null}

      {tab === "settings" ? (
        <SettingsView tr={tr} settings={props.settings} actions={props.actions} />
      ) : null}

      {tagManagerOpen ? (
        <TagManager
          tr={tr}
          tags={props.tags}
          createAction={props.actions.createTag}
          deleteAction={props.actions.deleteTag}
          close={() => setTagManagerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function KeywordTable(props: {
  tr: boolean;
  projectId: string;
  keywords: KeywordRow[];
  filteredKeywords: KeywordRow[];
  groups: GroupCard[];
  tags: TagCard[];
  selectedIds: string[];
  setSelectedIds: (value: string[]) => void;
  selectAllVisible: () => void;
  search: string;
  setSearch: (value: string) => void;
  country: string;
  setCountry: (value: string) => void;
  device: string;
  setDevice: (value: string) => void;
  segment: string;
  setSegment: (value: string) => void;
  positionBand: string;
  setPositionBand: (value: string) => void;
  quick: string;
  setQuick: (value: string) => void;
  allSegments: Array<{ id: string; name: string; type: "group" | "tag" }>;
  countries: Array<{
    locationCode: number;
    code: string;
    name: string;
    flag: string;
  }>;
  exportCsv: () => void;
  exportJson: () => void;
  assignTagAction: Action;
  runRankCheckAction: Action;
  openTagManager: () => void;
}) {
  const {
    tr,
    filteredKeywords,
    selectedIds,
    setSelectedIds,
    selectAllVisible,
  } = props;

  return (
    <>
      <section className="panel rankFilterPanel">
        <div className="rankFilters">
          <input
            className="rankSearch"
            value={props.search}
            onChange={(event) => props.setSearch(event.target.value)}
            placeholder={tr ? "Keyword, URL, grup veya tag ara…" : "Search keyword, URL, group or tag…"}
          />
          <select value={props.country} onChange={(event) => props.setCountry(event.target.value)}>
            <option value="all">{tr ? "Tüm ülkeler" : "All countries"}</option>
            {props.countries.map((item) => (
              <option key={item.locationCode} value={item.locationCode}>
                {item.flag} {item.name}
              </option>
            ))}
          </select>
          <select value={props.device} onChange={(event) => props.setDevice(event.target.value)}>
            <option value="all">{tr ? "Tüm cihazlar" : "All devices"}</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </select>
          <select value={props.segment} onChange={(event) => props.setSegment(event.target.value)}>
            <option value="all">{tr ? "Tüm gruplar/tagler" : "All groups/tags"}</option>
            {props.allSegments.map((item) => (
              <option key={item.type + ":" + item.id} value={item.type + ":" + item.id}>
                {item.type === "group" ? "◈ " : "# "}
                {item.name}
              </option>
            ))}
          </select>
          <select
            value={props.positionBand}
            onChange={(event) => props.setPositionBand(event.target.value)}
          >
            <option value="all">{tr ? "Tüm pozisyonlar" : "All positions"}</option>
            <option value="top3">Top 3</option>
            <option value="top10">Top 10</option>
            <option value="top20">Top 20</option>
            <option value="21plus">21+</option>
            <option value="unranked">{tr ? "Bulunamadı" : "Unranked"}</option>
          </select>
          <button className="secondaryButton" type="button" onClick={props.openTagManager}>
            # {tr ? "Tag Yönetimi" : "Manage Tags"}
          </button>
        </div>
      </section>

      <section className="panel rankKeywordTablePanel">
        <div className="panelHeader rankKeywordTableHeader">
          <div>
            <h2>{tr ? "Takip Edilen Keywordler" : "Tracked Keywords"}</h2>
            <p>
              {filteredKeywords.length} / {props.keywords.length}{" "}
              {tr ? "keyword gösteriliyor" : "keywords shown"}
            </p>
          </div>
          <div className="rankTableHeaderActions">
            <button className="secondaryButton" type="button" onClick={props.exportCsv}>
              ⇩ CSV
            </button>
            <button className="ghostButton" type="button" onClick={props.exportJson}>
              JSON
            </button>
          </div>
        </div>

        <div className="rankQuickFilters">
          {[
            ["all", tr ? "Tümü" : "All"],
            ["winners", tr ? "Yükselenler" : "Winners"],
            ["losers", tr ? "Düşenler" : "Losers"],
            ["top10", "Top 10"],
            ["attention", tr ? "Dikkat Gerektiren" : "Needs attention"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={props.quick === key ? "active" : ""}
              onClick={() => props.setQuick(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {selectedIds.length && props.tags.length ? (
          <div className="rankBulkBar">
            <strong>{selectedIds.length} selected</strong>
            <form action={props.assignTagAction}>
              <input type="hidden" name="keywordIds" value={selectedIds.join(",")} />
              <select name="tagId" required defaultValue="">
                <option value="" disabled>
                  {tr ? "Tag seç" : "Choose tag"}
                </option>
                {props.tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <button className="primaryButton" type="submit">
                {tr ? "Tag Ata" : "Assign Tag"}
              </button>
            </form>
          </div>
        ) : null}

        <div className="rankTableWrap">
          <table className="rankProfessionalTable">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={
                      filteredKeywords.length > 0 &&
                      filteredKeywords.every((item) => selectedIds.includes(item.id))
                    }
                    onChange={selectAllVisible}
                  />
                </th>
                <th>Keyword</th>
                <th>{tr ? "Gruplar / Tagler" : "Groups / Tags"}</th>
                <th>{tr ? "Ülke / Cihaz" : "Country / Device"}</th>
                <th>{tr ? "Pozisyon" : "Position"}</th>
                <th>Δ</th>
                <th>{tr ? "En İyi" : "Best"}</th>
                <th>GSC Clicks</th>
                <th>Impressions</th>
                <th>CTR</th>
                <th>{tr ? "Son Kontrol" : "Last Check"}</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredKeywords.map((item) => {
                const loc = locationInfo(item.locationCode);
                const delta = positionDelta(
                  item.latestPosition,
                  item.previousPosition,
                );
                return (
                  <tr key={item.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(item.id)}
                        onChange={() =>
                          setSelectedIds(
                            selectedIds.includes(item.id)
                              ? selectedIds.filter((id) => id !== item.id)
                              : [...selectedIds, item.id],
                          )
                        }
                      />
                    </td>
                    <td className="rankKeywordIdentity">
                      <strong>{item.keyword}</strong>
                      <span>{item.lastRankingUrl || item.targetUrl || "—"}</span>
                    </td>
                    <td>
                      <div className="rankTagList">
                        {item.groups.slice(0, 2).map((group) => (
                          <span className="rankTag rankTag-purple" key={group.id}>
                            {group.name}
                          </span>
                        ))}
                        {item.tags.slice(0, 3).map((tag) => (
                          <span
                            className={"rankTag rankTag-" + tag.color}
                            key={tag.id}
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="rankLocationCell">
                        <span>{loc.flag}</span>
                        <div>
                          <strong>{loc.code}</strong>
                          <small>{item.device}</small>
                        </div>
                      </div>
                    </td>
                    <td className="rankPositionCell">
                      <strong>
                        {item.lastPosition === null ? "—" : "#" + item.lastPosition}
                      </strong>
                    </td>
                    <td>
                      <span
                        className={
                          delta > 0
                            ? "rankDelta rankDeltaUp"
                            : delta < 0
                              ? "rankDelta rankDeltaDown"
                              : "rankDelta"
                        }
                      >
                        {delta > 0
                          ? "↑ " + delta
                          : delta < 0
                            ? "↓ " + Math.abs(delta)
                            : "—"}
                      </span>
                    </td>
                    <td>{item.bestPosition ? "#" + item.bestPosition : "—"}</td>
                    <td>{item.gscClicks.toLocaleString()}</td>
                    <td>{item.gscImpressions.toLocaleString()}</td>
                    <td>{(item.gscCtr * 100).toFixed(2)}%</td>
                    <td>
                      {item.lastCheckedAt
                        ? new Date(item.lastCheckedAt).toLocaleString(
                            tr ? "tr-TR" : "en-GB",
                            { dateStyle: "short", timeStyle: "short" },
                          )
                        : "—"}
                    </td>
                    <td>
                      <span
                        className={
                          item.lastStatus === "succeeded"
                            ? "rankStatus rankStatusGood"
                            : item.lastStatus === "failed"
                              ? "rankStatus rankStatusBad"
                              : "rankStatus"
                        }
                      >
                        {item.lastStatus}
                      </span>
                    </td>
                    <td>
                      <form action={props.runRankCheckAction}>
                        <input type="hidden" name="keywordId" value={item.id} />
                        <button
                          className="rankRowAction"
                          type="submit"
                          title={tr ? "Bu keywordü kontrol et" : "Check this keyword"}
                        >
                          ↻
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filteredKeywords.length ? (
            <div className="emptyState rankTableEmpty">
              <strong>{tr ? "Filtreye uyan keyword yok" : "No matching keywords"}</strong>
              <span>{tr ? "Filtreleri gevşetmeyi deneyin." : "Try clearing some filters."}</span>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

function SegmentsView(props: {
  tr: boolean;
  groups: GroupCard[];
  tags: TagCard[];
  openTagManager: () => void;
  onOpenGroup: (id: string) => void;
  onOpenTag: (id: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{props.tr ? "Gruplar & Tagler" : "Groups & Tags"}</h2>
          <p>
            {props.tr
              ? "Dinamik GSC segmentleri ile manuel tagleri ayrı yönetin."
              : "Manage dynamic GSC segments and manual tags separately."}
          </p>
        </div>
        <button className="primaryButton" type="button" onClick={props.openTagManager}>
          # {props.tr ? "Tag Yönetimi" : "Manage Tags"}
        </button>
      </div>
      <div className="rankSegmentGrid rankSegmentGridWide">
        {props.groups.map((group) => (
          <button
            className="rankSegmentCard"
            type="button"
            key={group.id}
            onClick={() => props.onOpenGroup(group.id)}
          >
            <div className="rankSegmentCardTop">
              <span className="rankSegmentType">Dynamic GSC Group</span>
              <span>{group.count} KW</span>
            </div>
            <strong>{group.name}</strong>
            <div className="rankSegmentStats">
              <div><b>{group.metric || "GSC"}</b><span>metric</span></div>
              <div><b>{group.windowDays}d</b><span>window</span></div>
              <div><b>{group.lastStatus}</b><span>status</span></div>
            </div>
          </button>
        ))}
        {props.tags.map((tag) => (
          <button
            className="rankSegmentCard"
            type="button"
            key={tag.id}
            onClick={() => props.onOpenTag(tag.id)}
          >
            <div className="rankSegmentCardTop">
              <span className={"rankTag rankTag-" + tag.color}>Manual Tag</span>
              <span>{tag.count} KW</span>
            </div>
            <strong>{tag.name}</strong>
            <div className="rankSegmentStats">
              <div><b>{tag.count}</b><span>keywords</span></div>
              <div><b>Manual</b><span>source</span></div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function CountriesView(props: {
  tr: boolean;
  countries: Array<{
    locationCode: number;
    code: string;
    name: string;
    flag: string;
    count: number;
    top10: number;
    improved: number;
    declined: number;
    avgPosition: number | null;
  }>;
  onOpen: (code: number) => void;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{props.tr ? "Ülke Bazlı Sıralamalar" : "Country Rankings"}</h2>
          <p>
            {props.tr
              ? "Her location code için ayrı ranking görünümü."
              : "Separate ranking view for every tracked location."}
          </p>
        </div>
      </div>
      <div className="rankCountryGrid rankCountryGridWide">
        {props.countries.map((item) => (
          <button
            className="rankCountryCard rankCountryCardDetailed"
            type="button"
            key={item.locationCode}
            onClick={() => props.onOpen(item.locationCode)}
          >
            <div>
              <span className="rankCountryFlag">{item.flag}</span>
              <strong>{item.name}</strong>
            </div>
            <b>{item.avgPosition === null ? "—" : item.avgPosition.toFixed(1)}</b>
            <small>Average position</small>
            <div className="rankCountryMiniStats">
              <span><b>{item.count}</b> keywords</span>
              <span><b>{item.top10}</b> Top 10</span>
              <span className="rankGood"><b>{item.improved}</b> ↑</span>
              <span className="rankBad"><b>{item.declined}</b> ↓</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function LandingPagesView(props: { tr: boolean; pages: LandingPage[] }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{props.tr ? "Ranking Landing Pages" : "Ranking Landing Pages"}</h2>
          <p>
            {props.tr
              ? "Keywordleri ranking URL bazında konsolide eder."
              : "Consolidates tracked keywords by ranking URL."}
          </p>
        </div>
      </div>
      <div className="rankLandingList">
        {props.pages.map((page) => (
          <article key={page.url}>
            <div className="rankLandingIdentity">
              <strong>{page.url}</strong>
              <span>{page.keywordCount} keywords</span>
            </div>
            <div><b>{page.avgPosition ? page.avgPosition.toFixed(1) : "—"}</b><span>Avg pos.</span></div>
            <div><b>{page.top10}</b><span>Top 10</span></div>
            <div><b>{page.clicks.toLocaleString()}</b><span>GSC clicks</span></div>
            <div><b>{page.impressions.toLocaleString()}</b><span>Impressions</span></div>
          </article>
        ))}
        {!props.pages.length ? (
          <div className="emptyState">
            <strong>{props.tr ? "Ranking URL henüz oluşmadı" : "No ranking URLs yet"}</strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CompetitorsView(props: {
  tr: boolean;
  competitors: Competitor[];
  serpFeatures: SerpFeature[];
}) {
  return (
    <div className="rankWorkspaceOverviewGrid">
      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{props.tr ? "SERP Rakipleri" : "SERP Competitors"}</h2>
            <p>
              {props.tr
                ? "Son rank check sonuçlarında en sık görülen domainler."
                : "Domains most frequently seen in recent rank checks."}
            </p>
          </div>
        </div>
        <div className="rankCompetitorList">
          {props.competitors.slice(0, 25).map((item, index) => (
            <article key={item.domain}>
              <span>#{index + 1}</span>
              <strong>{item.domain}</strong>
              <div><b>{item.appearances}</b><small>appearances</small></div>
              <div><b>{item.avgRank.toFixed(1)}</b><small>avg SERP rank</small></div>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>SERP Features</h2>
            <p>{props.tr ? "Takip edilen SERP'lerde görülen özellikler." : "Features observed across tracked SERPs."}</p>
          </div>
        </div>
        <div className="rankFeatureGrid">
          {props.serpFeatures.slice(0, 20).map((item) => (
            <div key={item.name}>
              <strong>{item.name}</strong>
              <span>{item.count} SERPs</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AlertsView(props: {
  tr: boolean;
  alerts: Array<KeywordRow & { delta: number }>;
  runRankCheckAction: Action;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{props.tr ? "Ranking Alerts" : "Ranking Alerts"}</h2>
          <p>
            {props.tr
              ? "Düşen, bulunamayan veya check hatası olan keywordler."
              : "Declining, unranked or failed tracked keywords."}
          </p>
        </div>
      </div>
      <div className="rankAlertList">
        {props.alerts.map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.keyword}</strong>
              <span>{item.lastRankingUrl || item.targetUrl || "—"}</span>
            </div>
            <div>
              <b>{item.lastPosition === null ? "Not found" : "#" + item.lastPosition}</b>
              <span className={item.delta < 0 ? "rankBad" : ""}>
                {item.delta < 0 ? "↓ " + Math.abs(item.delta) : item.lastStatus}
              </span>
            </div>
            <form action={props.runRankCheckAction}>
              <input type="hidden" name="keywordId" value={item.id} />
              <button className="secondaryButton" type="submit">
                ↻ Check
              </button>
            </form>
          </article>
        ))}
        {!props.alerts.length ? (
          <div className="emptyState">
            <strong>{props.tr ? "Açık ranking alert yok" : "No open rank alerts"}</strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SettingsView(props: {
  tr: boolean;
  settings: Settings;
  actions: Props["actions"];
}) {
  return (
    <div className="rankSettingsGrid">
      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{props.tr ? "Rank Tracking Ayarları" : "Rank Tracking Settings"}</h2>
            <p>{props.tr ? "Cadence, GSC discovery ve default SERP context." : "Cadence, GSC discovery and default SERP context."}</p>
          </div>
        </div>
        <form className="formPanel" action={props.actions.saveSettings}>
          <div className="formGrid2">
            <label className="checkboxLabel">
              <input name="active" type="checkbox" defaultChecked={props.settings.active} />
              Background rank tracking active
            </label>
            <label className="checkboxLabel">
              <input
                name="autoDiscover"
                type="checkbox"
                defaultChecked={props.settings.auto_discover_enabled}
              />
              Auto-discover keywords from GSC
            </label>
            <label className="checkboxLabel">
              <input
                name="autoFindings"
                type="checkbox"
                defaultChecked={props.settings.auto_findings_enabled}
              />
              Create rank findings
            </label>
            <label>
              Max auto keywords
              <input
                name="maxAutoKeywords"
                type="number"
                min="0"
                max="1000"
                defaultValue={props.settings.max_auto_keywords}
              />
            </label>
            <label>
              Min 28-day impressions
              <input
                name="minImpressions"
                type="number"
                min="0"
                defaultValue={props.settings.min_impressions_28d}
              />
            </label>
            <label>
              Position min
              <input
                name="positionMin"
                type="number"
                step="0.1"
                defaultValue={props.settings.position_min}
              />
            </label>
            <label>
              Position max
              <input
                name="positionMax"
                type="number"
                step="0.1"
                defaultValue={props.settings.position_max}
              />
            </label>
            <label>
              Default location code
              <input
                name="locationCode"
                type="number"
                defaultValue={props.settings.default_location_code}
              />
            </label>
            <label>
              Language
              <input
                name="languageCode"
                defaultValue={props.settings.default_language_code}
              />
            </label>
            <label>
              Device
              <select name="device" defaultValue={props.settings.default_device}>
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
            <label>
              Daily high-priority limit
              <input
                name="dailyHighPriorityLimit"
                type="number"
                defaultValue={props.settings.daily_high_priority_limit}
              />
            </label>
          </div>
          <div className="buttonRow">
            <button className="primaryButton" type="submit">
              {props.tr ? "Ayarları Kaydet" : "Save Settings"}
            </button>
            <button
              className="secondaryButton"
              type="submit"
              formAction={props.actions.seedFromGsc}
            >
              {props.tr ? "GSC'den Seed Et" : "Seed From GSC"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>{props.tr ? "Keyword Ekle" : "Add Keywords"}</h2>
            <p>{props.tr ? "Manuel keywordleri toplu ekleyin." : "Bulk-add manual tracked keywords."}</p>
          </div>
        </div>
        <form className="formPanel" action={props.actions.addKeywords}>
          <label>
            Keywords
            <textarea
              name="keywords"
              rows={8}
              required
              placeholder={"best calorie tracker\ncalorie deficit calculator"}
            />
          </label>
          <label>
            Target URL
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
                defaultValue={props.settings.default_location_code}
              />
            </label>
            <label>
              Language
              <input
                name="languageCode"
                defaultValue={props.settings.default_language_code}
              />
            </label>
            <label>
              Device
              <select name="device" defaultValue={props.settings.default_device}>
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
          </div>
          <button className="primaryButton" type="submit">
            {props.tr ? "Keywordleri Ekle" : "Add Keywords"}
          </button>
        </form>
      </section>
    </div>
  );
}

function TagManager(props: {
  tr: boolean;
  tags: TagCard[];
  createAction: Action;
  deleteAction: Action;
  close: () => void;
}) {
  return (
    <div className="rankModalBackdrop" role="presentation" onMouseDown={props.close}>
      <div
        className="rankTagModal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="rankTagModalHead">
          <div>
            <h2>{props.tr ? "Tag Yönetimi" : "Tag Management"}</h2>
            <p>{props.tr ? "Manuel keyword segmentleri oluşturun." : "Create manual keyword segments."}</p>
          </div>
          <button type="button" onClick={props.close}>×</button>
        </div>
        <form className="rankTagCreate" action={props.createAction}>
          <input name="name" placeholder={props.tr ? "Yeni tag adı" : "New tag name"} required />
          <select name="colorKey" defaultValue="purple">
            <option value="purple">Purple</option>
            <option value="green">Green</option>
            <option value="blue">Blue</option>
            <option value="amber">Amber</option>
            <option value="red">Red</option>
            <option value="gray">Gray</option>
          </select>
          <button className="primaryButton" type="submit">
            {props.tr ? "Tag Oluştur" : "Create Tag"}
          </button>
        </form>
        <div className="rankTagManageList">
          {props.tags.map((tag) => (
            <div key={tag.id}>
              <span className={"rankTag rankTag-" + tag.color}>{tag.name}</span>
              <small>{tag.count} keywords</small>
              <form action={props.deleteAction}>
                <input type="hidden" name="tagId" value={tag.id} />
                <button className="ghostButton" type="submit">
                  {props.tr ? "Sil" : "Delete"}
                </button>
              </form>
            </div>
          ))}
          {!props.tags.length ? (
            <div className="emptyState">
              <strong>{props.tr ? "Henüz manuel tag yok" : "No manual tags yet"}</strong>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
