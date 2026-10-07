
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";
import { scheduleDescription, type ScheduleConfig, type ScheduleKind } from "@/lib/command/schedule";
import {
  auditLead,
  convertLead,
  createLeadDeck,
  createSalesCampaign,
  qualifyCampaignTopLeads,
  qualifyLead,
  runSalesCampaign,
  saveSalesCampaignAutomation,
  setLeadStage,
} from "./actions";

export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;
function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 4,
  }).format(value);
}

function scoreClass(score: number) {
  if (score >= 80) return "salesScoreHot";
  if (score >= 65) return "salesScoreWarm";
  return "salesScoreCool";
}

const STAGES = [
  "discovered",
  "qualified",
  "audited",
  "contact_found",
  "outreach_ready",
  "contacted",
  "replied",
  "meeting",
  "proposal",
  "won",
  "lost",
  "rejected",
];

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const stageFilter = scalar(query.stage, "all");
  const supabase = await createClient();

  const [
    { data: campaigns },
    { data: allLeads },
    { data: campaignLinks },
    { data: contacts },
    { data: runs },
    { data: projects },
  ] = await Promise.all([
    supabase
      .from("sales_campaigns")
      .select("id,name,status,country,industry,location_code,language_code,queries,exclusions,depth,min_score,max_candidates,max_run_cost_usd,monthly_budget_usd,monthly_budget_hard_stop,last_run_at,auto_discovery_enabled,schedule_kind,schedule_config,timezone,auto_qualify_count,last_auto_run_at,last_auto_status,last_auto_error,auto_failure_count,created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("sales_leads")
      .select("id,domain,company_name,country,industry,stage,qualification_status,score,score_breakdown,evidence,converted_project_id,last_qualified_at,created_at,updated_at")
      .order("score", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase
      .from("sales_campaign_leads")
      .select("campaign_id,lead_id,source_query,source_rank,source_url,discovered_at")
      .order("discovered_at", { ascending: false }),
    supabase
      .from("sales_contacts")
      .select("id,lead_id,email,phone,verification_status,is_primary,source")
      .order("created_at", { ascending: false }),
    supabase
      .from("sales_discovery_runs")
      .select("id,campaign_id,status,queries_requested,queries_completed,candidates_seen,leads_created,leads_linked,actual_cost,result,error,started_at,completed_at")
      .gte("started_at", monthStartIso())
      .order("started_at", { ascending: false })
      .limit(250),
    supabase
      .from("projects")
      .select("id,name,project_type")
      .eq("project_type", "lead_prospect"),
  ]);

  const campaignMap = new Map((campaigns || []).map((item) => [item.id, item]));
  const projectMap = new Map((projects || []).map((item) => [item.id, item]));
  const latestLinkByLead = new Map<string, any>();
  for (const link of campaignLinks || []) {
    if (!latestLinkByLead.has(link.lead_id)) latestLinkByLead.set(link.lead_id, link);
  }

  const contactsByLead = new Map<string, any[]>();
  for (const contact of contacts || []) {
    const list = contactsByLead.get(contact.lead_id) || [];
    list.push(contact);
    contactsByLead.set(contact.lead_id, list);
  }

  const leads = (allLeads || []).filter((lead) =>
    stageFilter === "all" ? true : lead.stage === stageFilter,
  );

  const stageCounts = new Map<string, number>();
  for (const lead of allLeads || []) {
    stageCounts.set(lead.stage, (stageCounts.get(lead.stage) || 0) + 1);
  }

  const qualified = (allLeads || []).filter(
    (lead) => lead.qualification_status === "qualified",
  ).length;
  const audited = (allLeads || []).filter((lead) => lead.stage === "audited").length;
  const activeCampaigns = (campaigns || []).filter((item) =>
    ["draft", "active"].includes(item.status),
  ).length;
  const totalDiscoveryCost = (runs || []).reduce(
    (sum, run) => sum + Number(run.actual_cost || 0),
    0,
  );
  const dataForSeoReady = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );
  const openAiReady = Boolean(process.env.OPENAI_API_KEY);

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Sales OS</p>
          <h1>{tr ? "Lead Keşfi & Pipeline" : "Lead Discovery & Pipeline"}</h1>
          <p className="muted">
            {tr ? "Potansiyel müşterileri düşük maliyetle keşfet, deterministik olarak qualify et ve agentları yalnızca takip etmeye değer leadlerde kullan." : "Discover prospects cheaply, qualify deterministically, then use agents only on leads worth pursuing."}
          </p>
        </div>
        <div className="salesRuntimeBadges">
          <span className={dataForSeoReady ? "healthGood" : "healthWarn"}>
            SERP {dataForSeoReady ? (tr ? "hazır" : "ready") : (tr ? "bekliyor" : "waiting")}
          </span>
          <span className={openAiReady ? "healthGood" : "healthWarn"}>
            Sales Agent {openAiReady ? (tr ? "hazır" : "ready") : (tr ? "bekliyor" : "waiting")}
          </span>
        </div>
      </header>

      {scalar(query.error) ? (
        <p className="formMessage formError pageMessage">{scalar(query.error)}</p>
      ) : null}
      {scalar(query.message) ? (
        <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p>
      ) : null}

      <section className="healthGrid">
        <article className="healthCard">
          <span>{tr ? "Toplam lead" : "Total leads"}</span>
          <strong>{allLeads?.length || 0}</strong>
          <small>Deduplicated by domain</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Qualified" : "Qualified"}</span>
          <strong>{qualified}</strong>
          <small>Score threshold passed</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Denetlenen" : "Audited"}</span>
          <strong>{audited}</strong>
          <small>Public prospect audit complete</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Aktif kampanyalar" : "Active campaigns"}</span>
          <strong>{activeCampaigns}</strong>
          <small>Draft + active</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Toplantı / teklif" : "Meetings / proposals"}</span>
          <strong>{(stageCounts.get("meeting") || 0) + (stageCounts.get("proposal") || 0)}</strong>
          <small>High-intent pipeline</small>
        </article>
        <article className="healthCard">
          <span>{tr ? "Keşif maliyeti" : "Discovery spend"}</span>
          <strong>{money(totalDiscoveryCost)}</strong>
          <small>Last {runs?.length || 0} runs</small>
        </article>
      </section>

      <div className="twoCol salesTopGrid">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>{tr ? "Keşif kampanyası oluştur" : "Create discovery campaign"}</h2>
              <p>Use commercial ICP searches. SignalCore will deduplicate domains before qualification.</p>
            </div>
          </div>

          <form className="formPanel salesCampaignForm" action={createSalesCampaign}>
            <div className="formGrid2">
              <label>
                Campaign name
                <input name="name" required placeholder="UK SaaS SEO Prospects" />
              </label>
              <label>
                Industry / niche
                <input name="industry" placeholder="B2B SaaS" />
              </label>
              <label>
                Country
                <input name="country" placeholder="United Kingdom" />
              </label>
              <label>
                DataForSEO location code
                <input name="locationCode" type="number" defaultValue="2826" />
              </label>
              <label>
                Language code
                <input name="languageCode" defaultValue="en" />
              </label>
              <label>
                SERP depth
                <input name="depth" type="number" min="10" max="100" defaultValue="20" />
              </label>
              <label>
                Qualification threshold
                <input name="minScore" type="number" min="0" max="100" defaultValue="65" />
              </label>
              <label>
                Max candidates
                <input name="maxCandidates" type="number" min="1" max="1000" defaultValue="100" />
              </label>
              <label>
                Max cost / run (USD)
                <input name="maxRunCost" type="number" min="0" step="0.01" defaultValue="0.25" />
              </label>
              <label>
                Monthly SERP budget (USD)
                <input name="monthlyBudget" type="number" min="0" step="0.01" defaultValue="5" />
              </label>
              <label className="checkboxLabel">
                <input name="monthlyBudgetHardStop" type="checkbox" defaultChecked />
                Monthly hard stop
              </label>
            </div>
            <label>
              Discovery queries · one per line
              <textarea
                name="queries"
                rows={7}
                required
                placeholder={"b2b saas companies london\ncybersecurity companies uk\nfintech software companies london"}
              />
            </label>
            <label>
              Domain exclusions · optional
              <textarea
                name="exclusions"
                rows={3}
                placeholder={"example.com\ncompetitor.com"}
              />
            </label>
            <button className="primaryButton" type="submit">Create campaign</button>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Campaigns</h2>
              <p>Discovery uses paid SERP data; qualification uses cheap direct HTTP evidence.</p>
            </div>
          </div>

          <div className="salesCampaignList">
            {(campaigns || []).length ? (
              (campaigns || []).map((campaign) => {
                const queries = Array.isArray(campaign.queries)
                  ? campaign.queries.map(String)
                  : [];
                const campaignRuns = (runs || []).filter(
                  (run) => run.campaign_id === campaign.id,
                );
                const latestRun = campaignRuns[0];

                return (
                  <article className="salesCampaignCard" key={campaign.id}>
                    <div className="salesCampaignTop">
                      <div>
                        <p className="eyebrow">
                          {campaign.country || "Any market"} · {campaign.industry || "Any niche"}
                        </p>
                        <h3>{campaign.name}</h3>
                      </div>
                      <span className={"jobStatus job-" + campaign.status}>
                        {campaign.status}
                      </span>
                    </div>
                    <div className="salesCampaignMeta">
                      <span>{queries.length} queries</span>
                      <span>Top {campaign.depth}</span>
                      <span>Min score {campaign.min_score}</span>
                      <span>Run cap {money(Number(campaign.max_run_cost_usd || 0))}</span>
                      <span>
                        Month{" "}
                        {money(
                          campaignRuns.reduce(
                            (sum, run) => sum + Number(run.actual_cost || 0),
                            0,
                          ),
                        )}
                        {" / "}
                        {money(Number(campaign.monthly_budget_usd || 0))}
                        {campaign.monthly_budget_hard_stop ? " · hard stop" : ""}
                      </span>
                    </div>
                    <div className="salesQueryPreview">
                      {queries.slice(0, 4).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                    {latestRun ? (
                      <div className="salesRunSummary">
                        <strong>Latest run</strong>
                        <span>
                          {latestRun.queries_completed}/{latestRun.queries_requested} queries ·{" "}
                          {latestRun.leads_created} new · {latestRun.leads_linked} linked ·{" "}
                          {money(Number(latestRun.actual_cost || 0))}
                        </span>
                      </div>
                    ) : null}

                    <div className="salesAutomationBox">
                      <div className="salesAutomationHeader">
                        <div>
                          <strong>Background discovery</strong>
                          <span>
                            {campaign.auto_discovery_enabled && campaign.schedule_kind
                              ? scheduleDescription(
                                  campaign.schedule_kind as ScheduleKind,
                                  (campaign.schedule_config || {}) as ScheduleConfig,
                                  campaign.timezone || "Europe/Istanbul",
                                )
                              : "Automation off"}
                          </span>
                        </div>
                        <span className={"jobStatus job-" + (campaign.last_auto_status || "idle")}>
                          {campaign.last_auto_status || "idle"}
                        </span>
                      </div>
                      {campaign.last_auto_error ? (
                        <p className="formMessage formError">{campaign.last_auto_error}</p>
                      ) : null}
                      <form
                        className="salesAutomationForm"
                        action={saveSalesCampaignAutomation.bind(null, campaign.id)}
                      >
                        <label className="checkboxLabel">
                          <input
                            name="autoEnabled"
                            type="checkbox"
                            defaultChecked={Boolean(campaign.auto_discovery_enabled)}
                          />
                          Enable
                        </label>
                        <label>
                          Cadence
                          <select name="scheduleKind" defaultValue={campaign.schedule_kind || "weekly"}>
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                            <option value="monthly">Monthly</option>
                          </select>
                        </label>
                        <label>
                          Time
                          <input
                            name="timeLocal"
                            type="time"
                            defaultValue={
                              String(
                                ((campaign.schedule_config || {}) as Record<string, unknown>).time_local ||
                                  "10:00",
                              )
                            }
                          />
                        </label>
                        <label>
                          Week days
                          <input
                            name="daysOfWeek"
                            defaultValue={
                              Array.isArray(
                                ((campaign.schedule_config || {}) as Record<string, unknown>).days_of_week,
                              )
                                ? (
                                    ((campaign.schedule_config || {}) as Record<string, unknown>)
                                      .days_of_week as unknown[]
                                  ).join(",")
                                : "1"
                            }
                            placeholder="1,3,5"
                          />
                        </label>
                        <label>
                          Month day
                          <input
                            name="dayOfMonth"
                            type="number"
                            min="1"
                            max="31"
                            defaultValue={
                              Number(
                                ((campaign.schedule_config || {}) as Record<string, unknown>).day_of_month ||
                                  1,
                              )
                            }
                          />
                        </label>
                        <label>
                          Auto qualify
                          <select
                            name="autoQualifyCount"
                            defaultValue={String(campaign.auto_qualify_count || 0)}
                          >
                            <option value="0">None</option>
                            <option value="3">Top 3</option>
                            <option value="5">Top 5</option>
                            <option value="10">Top 10</option>
                          </select>
                        </label>
                        <label>
                          Timezone
                          <input
                            name="timezone"
                            defaultValue={campaign.timezone || "Europe/Istanbul"}
                          />
                        </label>
                        <label>
                          Monthly SERP budget
                          <input
                            name="monthlyBudget"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={String(campaign.monthly_budget_usd || 0)}
                          />
                        </label>
                        <label className="checkboxLabel">
                          <input
                            name="monthlyBudgetHardStop"
                            type="checkbox"
                            defaultChecked={Boolean(campaign.monthly_budget_hard_stop)}
                          />
                          Monthly hard stop
                        </label>
                        <button className="ghostButton" type="submit">Save automation</button>
                      </form>
                    </div>

                    <div className="buttonRow">
                      <form action={runSalesCampaign.bind(null, campaign.id)}>
                        <button className="primaryButton" type="submit" disabled={!dataForSeoReady}>
                          Run discovery
                        </button>
                      </form>
                      <form action={qualifyCampaignTopLeads.bind(null, campaign.id)}>
                        <button className="secondaryButton" type="submit">
                          Qualify next 10
                        </button>
                      </form>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="emptyState smallEmpty">
                <strong>No discovery campaigns</strong>
                <span>Create the first ICP campaign to start building the pipeline.</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="panel salesPipelinePanel">
        <div className="panelHeader">
          <div>
            <h2>Pipeline</h2>
            <p>Human-controlled CRM stages. Automated discovery never sends outreach.</p>
          </div>
        </div>
        <div className="salesStageStrip">
          {STAGES.filter((stage) => !["lost", "rejected"].includes(stage)).map((stage) => (
            <Link
              href={stageFilter === stage ? "/sales" : "/sales?stage=" + stage}
              className={stageFilter === stage ? "salesStage active" : "salesStage"}
              key={stage}
            >
              <strong>{stageCounts.get(stage) || 0}</strong>
              <span>{stage.replaceAll("_", " ")}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Leads {stageFilter !== "all" ? "· " + stageFilter.replaceAll("_", " ") : ""}</h2>
            <p>
              Score combines SERP opportunity, business fit, public technical issues and contactability.
            </p>
          </div>
          {stageFilter !== "all" ? (
            <Link className="ghostButton" href="/sales">Clear filter</Link>
          ) : null}
        </div>

        {(leads || []).length ? (
          <div className="salesLeadList">
            {(leads || []).map((lead) => {
              const link = latestLinkByLead.get(lead.id);
              const campaign = link ? campaignMap.get(link.campaign_id) : null;
              const leadContacts = contactsByLead.get(lead.id) || [];
              const breakdown = (lead.score_breakdown || {}) as Record<string, unknown>;
              const project = lead.converted_project_id
                ? projectMap.get(lead.converted_project_id)
                : null;

              return (
                <article className="salesLeadCard" key={lead.id}>
                  <div className="salesLeadHeader">
                    <div className="salesLeadIdentity">
                      <div className={"salesScore " + scoreClass(Number(lead.score || 0))}>
                        {lead.score}
                      </div>
                      <div>
                        <p className="eyebrow">
                          {lead.industry || campaign?.industry || "Prospect"} ·{" "}
                          {lead.country || campaign?.country || "Unknown market"}
                        </p>
                        <h3>{lead.company_name || lead.domain}</h3>
                        <a href={"https://" + lead.domain} target="_blank" rel="noreferrer">
                          {lead.domain}
                        </a>
                      </div>
                    </div>
                    <div className="salesLeadBadges">
                      <span className="sourceBadge">{lead.stage.replaceAll("_", " ")}</span>
                      <span className={
                        lead.qualification_status === "qualified"
                          ? "confidence"
                          : "sourceBadge"
                      }>
                        {lead.qualification_status.replaceAll("_", " ")}
                      </span>
                    </div>
                  </div>

                  <div className="salesLeadEvidenceGrid">
                    <div>
                      <strong>Discovery</strong>
                      <span>{campaign?.name || "Unassigned"}</span>
                      <small>
                        {link?.source_query || "—"} {link?.source_rank ? "· rank " + link.source_rank : ""}
                      </small>
                    </div>
                    <div>
                      <strong>Score breakdown</strong>
                      <span>
                        SERP {String(breakdown.serp_opportunity || 0)} · Tech{" "}
                        {String(breakdown.technical_opportunity || 0)} · Contact{" "}
                        {String(breakdown.contactability || 0)}
                      </span>
                      <small>
                        Fit {String(breakdown.business_fit || 0)} · Web{" "}
                        {String(breakdown.web_presence || 0)}
                      </small>
                    </div>
                    <div>
                      <strong>Public contacts</strong>
                      <span>{leadContacts.length}</span>
                      <small>
                        {leadContacts
                          .slice(0, 2)
                          .map((contact) => contact.email || contact.phone)
                          .filter(Boolean)
                          .join(" · ") || "Not found yet"}
                      </small>
                    </div>
                    <div>
                      <strong>Prospect workspace</strong>
                      <span>{project ? project.name : "Not converted"}</span>
                      <small>{lead.last_qualified_at ? "Qualified " + new Date(lead.last_qualified_at).toLocaleDateString("en-GB") : "Not qualified yet"}</small>
                    </div>
                  </div>

                  <div className="salesLeadActions">
                    <form action={qualifyLead.bind(null, lead.id)}>
                      <button className="secondaryButton" type="submit">Qualify</button>
                    </form>

                    {!lead.converted_project_id && lead.qualification_status !== "rejected" ? (
                      <form action={convertLead.bind(null, lead.id)}>
                        <button className="secondaryButton" type="submit">
                          Convert to Lead Prospect
                        </button>
                      </form>
                    ) : null}

                    {lead.converted_project_id ? (
                      <>
                        <form action={auditLead.bind(null, lead.id)}>
                          <button className="primaryButton" type="submit" disabled={!openAiReady}>
                            Run prospect audit
                          </button>
                        </form>
                        <form action={createLeadDeck.bind(null, lead.id)}>
                          <button className="secondaryButton" type="submit" disabled={!openAiReady}>
                            Create sales deck
                          </button>
                        </form>
                        <Link className="ghostButton" href={"/projects/" + lead.converted_project_id}>
                          Open project
                        </Link>
                      </>
                    ) : null}

                    <form className="salesStageForm" action={setLeadStage.bind(null, lead.id)}>
                      <select name="stage" defaultValue={lead.stage}>
                        {STAGES.map((stage) => (
                          <option value={stage} key={stage}>
                            {stage.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                      <button className="ghostButton" type="submit">Update stage</button>
                    </form>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="emptyState">
            <strong>No leads in this view</strong>
            <span>Run a discovery campaign or clear the stage filter.</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Discovery run history</h2>
            <p>Provider cost and candidate yield by campaign run.</p>
          </div>
        </div>
        {(runs || []).length ? (
          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Campaign</th><th>Status</th><th>Queries</th><th>Candidates</th>
                  <th>New leads</th><th>Linked</th><th>Cost</th><th>Started</th>
                </tr>
              </thead>
              <tbody>
                {(runs || []).map((run) => (
                  <tr key={run.id}>
                    <td>{campaignMap.get(run.campaign_id)?.name || "Campaign"}</td>
                    <td><span className={"jobStatus job-" + run.status}>{run.status}</span></td>
                    <td>{run.queries_completed}/{run.queries_requested}</td>
                    <td>{run.candidates_seen}</td>
                    <td>{run.leads_created}</td>
                    <td>{run.leads_linked}</td>
                    <td>{money(Number(run.actual_cost || 0))}</td>
                    <td>{new Date(run.started_at).toLocaleString("en-GB")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState smallEmpty"><span>No discovery runs yet.</span></div>
        )}
      </section>
    </div>
  );
}
