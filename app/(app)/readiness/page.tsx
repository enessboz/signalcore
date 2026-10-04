import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type ReadinessItem = {
  label: string;
  ready: boolean;
  optional?: boolean;
  detail: string;
  actionHref?: string;
  actionLabel?: string;
};

function statusLabel(item: ReadinessItem) {
  if (item.ready) return "Ready";
  if (item.optional) return "Optional";
  return "Required";
}

function statusClass(item: ReadinessItem) {
  if (item.ready) return "readinessReady";
  if (item.optional) return "readinessOptional";
  return "readinessRequired";
}

export default async function ReadinessPage() {
  const supabase = await createClient();

  const [
    { data: google },
    { data: resources },
    { data: agents },
    { count: pendingApprovals },
    { count: activeSchedules },
    { count: failedJobs },
    { count: brainEntries },
    { count: repositoryBindings },
    { count: crawlRuns },
    { count: outputs },
    { count: projects },
    { count: budgetLimits },
    { count: activeTechnicalSchedules },
    { count: activeSalesAutomations },
    { count: activeRankProjects },
    { count: activeOpportunityProjects },
    { count: monitoringInterventions },
    { count: pendingInterventionChecks },
    { data: projectBindings },
    { count: queuedSyncJobs },
    { count: runningSyncJobs },
    { count: failedSyncJobs },
    { count: failedSyncDates },
    { count: recentWorkerRuns },
    { count: recentWorkerFailures },
    { count: staleRuntimeRuns },
    { data: passedUatRuns },
  ] = await Promise.all([
    supabase
      .from("connections")
      .select("status,external_account,last_discovery_at,last_error")
      .eq("provider", "google")
      .maybeSingle(),
    supabase
      .from("connection_resources")
      .select("resource_type")
      .eq("active", true),
    supabase
      .from("agent_definitions")
      .select("agent_key,name,status")
      .order("sort_order"),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("scheduled_tasks")
      .select("id", { count: "exact", head: true })
      .in("status", ["active", "running"]),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("global_brain_entries")
      .select("id", { count: "exact", head: true })
      .eq("active", true),
    supabase
      .from("project_repositories")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("crawl_runs")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("generated_outputs")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("budget_limits")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("technical_crawl_schedules")
      .select("id", { count: "exact", head: true })
      .in("status", ["active", "running"]),
    supabase
      .from("sales_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("auto_discovery_enabled", true)
      .in("status", ["draft", "active"]),
    supabase
      .from("rank_tracking_settings")
      .select("project_id", { count: "exact", head: true })
      .eq("active", true),
    supabase
      .from("opportunity_scan_settings")
      .select("project_id", { count: "exact", head: true })
      .eq("enabled", true),
    supabase
      .from("seo_interventions")
      .select("id", { count: "exact", head: true })
      .eq("status", "monitoring"),
    supabase
      .from("seo_intervention_checks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("project_bindings")
      .select("project_id,binding_type,auto_sync_enabled")
      .in("binding_type", ["gsc", "ga4"]),
    supabase
      .from("google_sync_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued"),
    supabase
      .from("google_sync_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "running"),
    supabase
      .from("google_sync_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("google_sync_date_log")
      .select("project_id", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("runtime_worker_runs")
      .select("id", { count: "exact", head: true })
      .gte("started_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
    supabase
      .from("runtime_worker_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("started_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
    supabase
      .from("runtime_worker_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - 15 * 60_000).toISOString()),
    supabase
      .from("agent_uat_runs")
      .select("scenario_key,expected_agent_key,execution_mode,status")
      .eq("status", "passed"),
  ]);

  const gscCount = (resources || []).filter((item) => item.resource_type === "gsc_property").length;
  const ga4Count = (resources || []).filter((item) => item.resource_type === "ga4_property").length;
  const openaiReady = Boolean(process.env.OPENAI_API_KEY);
  const supabaseWorkerReady = Boolean(process.env.SUPABASE_SECRET_KEY);
  const googleOAuthReady = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const encryptionReady = Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY);
  const dataForSeoReady = Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  const githubPrivateReady = Boolean(process.env.GITHUB_TOKEN);
  const cronSecretReady = Boolean(process.env.CRON_SECRET);
  const deterministicWorkerReady = supabaseWorkerReady && cronSecretReady;
  const salesWorkerReady = deterministicWorkerReady && dataForSeoReady;
  const rankWorkerReady = deterministicWorkerReady && dataForSeoReady;
  const opportunityWorkerReady = deterministicWorkerReady;
  const interventionWorkerReady = deterministicWorkerReady;
  const runtimeHealth = {
    queuedSyncJobs: queuedSyncJobs || 0,
    runningSyncJobs: runningSyncJobs || 0,
    failedSyncJobs: failedSyncJobs || 0,
    failedSyncDates: failedSyncDates || 0,
    recentWorkerRuns: recentWorkerRuns || 0,
    recentWorkerFailures: recentWorkerFailures || 0,
    staleRuntimeRuns: staleRuntimeRuns || 0,
  };

  const staleWorkerCount = runtimeHealth.staleRuntimeRuns;

  const boundGoogleProjects = new Set(
    (projectBindings || []).map((binding) => binding.project_id),
  ).size;
  const directUatAgents = new Set(
    (passedUatRuns || [])
      .filter((run) => run.execution_mode === "direct")
      .map((run) => run.expected_agent_key),
  );
  const routerUatPasses = (passedUatRuns || []).filter(
    (run) => run.execution_mode === "router",
  ).length;
  const uatSmokeReady = directUatAgents.size >= 7 && routerUatPasses >= 3;
  const dataHealthReady =
    runtimeHealth.failedSyncJobs === 0 &&
    runtimeHealth.failedSyncDates === 0 &&
    runtimeHealth.staleRuntimeRuns === 0;

  const totalScheduled =
    (activeSchedules || 0) +
    (activeTechnicalSchedules || 0) +
    (activeSalesAutomations || 0) +
    (activeRankProjects || 0) +
    (activeOpportunityProjects || 0) +
    (monitoringInterventions || 0);

  const coreItems: ReadinessItem[] = [
    {
      label: "Supabase application",
      ready: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
      detail: "Auth, project data, RLS and operational state.",
    },
    {
      label: "Google OAuth",
      ready: googleOAuthReady && google?.status === "connected",
      detail: google?.status === "connected"
        ? `${google.external_account || "Google account"} · ${gscCount} GSC · ${ga4Count} GA4 resources`
        : "Account-level Google connection is not fully ready.",
      actionHref: "/settings",
      actionLabel: "Google settings",
    },
    {
      label: "Credential encryption",
      ready: encryptionReady,
      detail: "Required for encrypted Google credential storage.",
    },
    {
      label: "OpenAI agent runtime",
      ready: openaiReady,
      detail: openaiReady
        ? "Chief Operator, Router and specialist model calls can run."
        : "Add OPENAI_API_KEY to Vercel before agent testing.",
      actionHref: "/agents",
      actionLabel: "Agent Center",
    },
    {
      label: "Background worker",
      ready: deterministicWorkerReady,
      detail: deterministicWorkerReady
        ? "Deterministic Google sync, technical crawl, Opportunity Engine and intervention monitoring workers can run."
        : "SUPABASE_SECRET_KEY and CRON_SECRET are required. Background workers remain intentionally paused.",
      actionHref: "/automations",
      actionLabel: "Automations",
    },
    {
      label: "Runtime operations & recovery",
      ready:
        deterministicWorkerReady &&
        staleWorkerCount === 0 &&
        runtimeHealth.recentWorkerFailures === 0,
      detail: deterministicWorkerReady
        ? `${runtimeHealth.recentWorkerRuns} owner-scoped worker run(s) in 24h · ${runtimeHealth.recentWorkerFailures} failed · ${staleWorkerCount} stale. Interrupted worker records recover automatically.`
        : "Operations telemetry and stale-run recovery activate with the server worker credential.",
      actionHref: "/operations",
      actionLabel: "Operations",
    },
    {
      label: "First-party data health",
      ready: boundGoogleProjects === 0 ? google?.status === "connected" : dataHealthReady,
      detail:
        boundGoogleProjects === 0
          ? "No project-level GSC/GA4 bindings are active yet."
          : `${boundGoogleProjects} project(s) bound · ${runtimeHealth.failedSyncJobs} failed sync job(s) · ${runtimeHealth.failedSyncDates} failed date(s).`,
      actionHref: "/projects",
      actionLabel: "Projects",
    },
    {
      label: "Agent UAT smoke gate",
      ready: uatSmokeReady,
      detail: `${directUatAgents.size}/7 specialist agents have a passing direct scenario · ${routerUatPasses}/3 minimum router scenarios passed.`,
      actionHref: "/agent-uat",
      actionLabel: "Agent UAT",
    },
    {
      label: "Production cost guardrail",
      ready: Boolean(budgetLimits),
      detail: budgetLimits
        ? `${budgetLimits} project/category monthly budget limit(s) configured with deterministic soft/hard budget findings.`
        : "Configure at least one AI/SERP/browser monthly budget before production model or paid-provider testing.",
      actionHref: "/costs",
      actionLabel: "Costs & Budgets",
    },
  ];

  const specialistItems: ReadinessItem[] = [
    {
      label: "Research / SERP provider",
      ready: dataForSeoReady,
      optional: true,
      detail: dataForSeoReady
        ? "DataForSEO live SERP evidence available."
        : "Optional: add DataForSEO credentials for live SERP/competitor research.",
    },
    {
      label: "Developer private GitHub access",
      ready: githubPrivateReady,
      optional: true,
      detail: githubPrivateReady
        ? "Private repository read context available."
        : "Public repos work without a token; private repos need GITHUB_TOKEN.",
    },
    {
      label: "Global Brain",
      ready: Boolean(brainEntries),
      detail: `${brainEntries || 0} active organization-wide context entries.`,
      actionHref: "/brain",
      actionLabel: "Global Brain",
    },
    {
      label: "Technical crawl automation",
      ready: deterministicWorkerReady,
      optional: true,
      detail: deterministicWorkerReady
        ? `${activeTechnicalSchedules || 0} active deterministic crawl schedule(s).`
        : `${activeTechnicalSchedules || 0} schedules configured; activation waits for worker secrets.`,
      actionHref: "/automations",
      actionLabel: "Automations",
    },
    {
      label: "Sales discovery automation",
      ready: salesWorkerReady,
      optional: true,
      detail: salesWorkerReady
        ? `${activeSalesAutomations || 0} automated Sales campaign(s) can run.`
        : `${activeSalesAutomations || 0} campaigns configured; DataForSEO + worker credentials are required.`,
      actionHref: "/sales",
      actionLabel: "Sales",
    },
    {
      label: "Rank tracking automation",
      ready: rankWorkerReady,
      optional: true,
      detail: rankWorkerReady
        ? `${activeRankProjects || 0} project(s) have active Rank Tracking.`
        : `${activeRankProjects || 0} project(s) configured; DataForSEO + worker credentials are required.`,
      actionHref: "/automations",
      actionLabel: "Automations",
    },
    {
      label: "Automatic Opportunity Engine",
      ready: opportunityWorkerReady,
      optional: true,
      detail: opportunityWorkerReady
        ? `${activeOpportunityProjects || 0} project(s) can scan warehouse evidence automatically.`
        : `${activeOpportunityProjects || 0} project(s) configured; worker credentials are required.`,
      actionHref: "/opportunities",
      actionLabel: "Intelligence Inbox",
    },
    {
      label: "SEO Intervention Monitoring",
      ready: interventionWorkerReady,
      optional: true,
      detail: interventionWorkerReady
        ? `${monitoringInterventions || 0} intervention(s) monitoring · ${pendingInterventionChecks || 0} pending checkpoint(s).`
        : `${monitoringInterventions || 0} intervention(s) configured · ${pendingInterventionChecks || 0} pending checkpoint(s); worker credentials are required for automatic evaluation.`,
      actionHref: "/automations",
      actionLabel: "Automations",
    },
    {
      label: "Native deliverables",
      ready: true,
      detail: `${outputs || 0} generated output(s) stored. Documents can render as DOCX and presentations as PPTX without another model call.`,
      actionHref: "/outputs",
      actionLabel: "Outputs",
    },
    {
      label: "Approval gate",
      ready: true,
      detail: `${pendingApprovals || 0} pending actions. External-impact proposals require explicit approval.`,
      actionHref: "/approvals",
      actionLabel: "Approval Center",
    },
    {
      label: "Technical evidence layer",
      ready: true,
      detail: `${crawlRuns || 0} crawl runs stored. Raw HTTP V2 includes internal link graph, depth/inlinks, sitemap/orphan evidence, delta regressions, canonical target checks and hreflang graph validation.`,
      actionHref: "/automations",
      actionLabel: "Crawler automations",
    },
    {
      label: "Persistent outputs",
      ready: true,
      detail: `${outputs || 0} generated deliverables stored.`,
      actionHref: "/outputs",
      actionLabel: "Outputs",
    },
  ];

  const requiredMissing = coreItems.filter((item) => !item.ready && !item.optional).length;
  const testingAgents = (agents || []).filter((agent) => ["testing", "active"].includes(agent.status)).length;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Launch checklist</p>
          <h1>System Readiness</h1>
          <p className="muted">
            One place to see what is installed, what is connected and what still blocks full autonomous operation.
          </p>
        </div>
        <div className={requiredMissing ? "readinessHero readinessHeroWarn" : "readinessHero readinessHeroReady"}>
          <strong>{requiredMissing ? `${requiredMissing} blockers` : "Core ready"}</strong>
          <span>{testingAgents} agents installed for testing</span>
        </div>
      </header>

      <section className="healthGrid readinessStats">
        <article className="healthCard">
          <span>Active projects</span>
          <strong>{projects || 0}</strong>
          <small>Owned + client + lead</small>
        </article>
        <article className="healthCard">
          <span>Agent team</span>
          <strong>{testingAgents}</strong>
          <small>Testing / active</small>
        </article>
        <article className="healthCard">
          <span>Scheduled work</span>
          <strong>{totalScheduled}</strong>
          <small>
            {activeSchedules || 0} agent · {activeTechnicalSchedules || 0} crawl · {activeSalesAutomations || 0} sales · {activeRankProjects || 0} rank · {activeOpportunityProjects || 0} intelligence · {monitoringInterventions || 0} interventions
          </small>
        </article>
        <article className="healthCard">
          <span>Pending approvals</span>
          <strong>{pendingApprovals || 0}</strong>
          <small>Human gate</small>
        </article>
        <article className="healthCard">
          <span>Failed jobs</span>
          <strong className={failedJobs ? "healthBad" : "healthGood"}>{failedJobs || 0}</strong>
          <small>Needs review</small>
        </article>
        <article className="healthCard">
          <span>Repo bindings</span>
          <strong>{repositoryBindings || 0}</strong>
          <small>Developer context</small>
        </article>
        <article className="healthCard">
          <span>Warehouse queue</span>
          <strong>{runtimeHealth.queuedSyncJobs + runtimeHealth.runningSyncJobs}</strong>
          <small>{runtimeHealth.queuedSyncJobs} queued · {runtimeHealth.runningSyncJobs} running · {runtimeHealth.failedSyncJobs} failed</small>
        </article>
        <article className="healthCard">
          <span>Worker operations</span>
          <strong>{runtimeHealth.recentWorkerRuns}</strong>
          <small>Owner-scoped runs · last 24h</small>
        </article>
        <article className="healthCard">
          <span>Stale workers</span>
          <strong className={staleWorkerCount ? "healthBad" : "healthGood"}>{staleWorkerCount}</strong>
          <small>Auto-recovery candidates</small>
        </article>
      </section>

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Core launch requirements</h2>
              <p>These determine whether the full runtime can operate.</p>
            </div>
          </div>
          <div className="readinessList">
            {coreItems.map((item) => (
              <div className="readinessRow" key={item.label}>
                <div className={`readinessIcon ${statusClass(item)}`}>{item.ready ? "✓" : "!"}</div>
                <div className="readinessCopy">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="readinessRowActions">
                  <span className={`readinessBadge ${statusClass(item)}`}>{statusLabel(item)}</span>
                  {item.actionHref ? <Link href={item.actionHref}>{item.actionLabel}</Link> : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Specialist capabilities</h2>
              <p>Optional providers and evidence layers.</p>
            </div>
          </div>
          <div className="readinessList">
            {specialistItems.map((item) => (
              <div className="readinessRow" key={item.label}>
                <div className={`readinessIcon ${statusClass(item)}`}>{item.ready ? "✓" : item.optional ? "○" : "!"}</div>
                <div className="readinessCopy">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="readinessRowActions">
                  <span className={`readinessBadge ${statusClass(item)}`}>{statusLabel(item)}</span>
                  {item.actionHref ? <Link href={item.actionHref}>{item.actionLabel}</Link> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel readinessLaunchPanel">
        <div>
          <h2>Activation order</h2>
          <p>
            1. Connect the final Vercel production account and copy the verified environment variables.
            2. Confirm Vercel Cron can invoke all protected worker routes.
            3. Run the Agent UAT smoke gate on a controlled project.
            4. Confirm Operations and project Data Health stay clean through at least one worker cycle.
            5. Enable Supabase leaked-password protection in the Auth dashboard.
            6. Only then enable production external-impact executors behind the approval gate.
          </p>
        </div>
        <div className="buttonRow">
          <Link href="/team" className="secondaryButton">Team Room</Link>
          <Link href="/command" className="primaryButton">Chief Operator</Link>
        </div>
      </section>
    </div>
  );
}
