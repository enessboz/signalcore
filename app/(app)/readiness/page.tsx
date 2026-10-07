import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";

type ReadinessItem = {
  label: string;
  ready: boolean;
  optional?: boolean;
  detail: string;
  actionHref?: string;
  actionLabel?: string;
};

function statusLabel(item: ReadinessItem, tr: boolean) {
  if (item.ready) return tr ? "Hazır" : "Ready";
  if (item.optional) return tr ? "Opsiyonel" : "Optional";
  return tr ? "Gerekli" : "Required";
}

function statusClass(item: ReadinessItem) {
  if (item.ready) return "readinessReady";
  if (item.optional) return "readinessOptional";
  return "readinessRequired";
}

export default async function ReadinessPage() {
  const locale = await getLocale();
  const tr = locale === "tr";
  const t = (en: string, trText: string) => (tr ? trText : en);
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
      label: t("Supabase application", "Supabase uygulaması"),
      ready: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
      detail: t("Auth, project data, RLS and operational state.", "Auth, proje verisi, RLS ve operasyonel durum."),
    },
    {
      label: "Google OAuth",
      ready: googleOAuthReady && google?.status === "connected",
      detail: google?.status === "connected"
        ? `${google.external_account || "Google account"} · ${gscCount} GSC · ${ga4Count} GA4 resources`
        : "Account-level Google connection is not fully ready.",
      actionHref: "/settings",
      actionLabel: t("Google settings", "Google ayarları"),
    },
    {
      label: t("Credential encryption", "Credential şifreleme"),
      ready: encryptionReady,
      detail: t("Required for encrypted Google credential storage.", "Şifrelenmiş Google credential saklama için gerekli."),
    },
    {
      label: t("OpenAI agent runtime", "OpenAI agent runtime"),
      ready: openaiReady,
      detail: openaiReady
        ? "Chief Operator, Router and specialist model calls can run."
        : "Add OPENAI_API_KEY to Vercel before agent testing.",
      actionHref: "/agents",
      actionLabel: t("Agent Center", "Agent Merkezi"),
    },
    {
      label: t("Background worker", "Arka plan worker'ı"),
      ready: deterministicWorkerReady,
      detail: deterministicWorkerReady
        ? "Deterministic Google sync, technical crawl, Opportunity Engine and intervention monitoring workers can run."
        : "SUPABASE_SECRET_KEY and CRON_SECRET are required. Background workers remain intentionally paused.",
      actionHref: "/automations",
      actionLabel: t("Automations", "Otomasyonlar"),
    },
    {
      label: t("Runtime operations & recovery", "Runtime operasyonları & recovery"),
      ready:
        deterministicWorkerReady &&
        staleWorkerCount === 0 &&
        runtimeHealth.recentWorkerFailures === 0,
      detail: deterministicWorkerReady
        ? `${runtimeHealth.recentWorkerRuns} owner-scoped worker run(s) in 24h · ${runtimeHealth.recentWorkerFailures} failed · ${staleWorkerCount} stale. Interrupted worker records recover automatically.`
        : "Operations telemetry and stale-run recovery activate with the server worker credential.",
      actionHref: "/operations",
      actionLabel: t("Operations", "Operasyonlar"),
    },
    {
      label: t("First-party data health", "First-party veri sağlığı"),
      ready: boundGoogleProjects === 0 ? google?.status === "connected" : dataHealthReady,
      detail:
        boundGoogleProjects === 0
          ? "No project-level GSC/GA4 bindings are active yet."
          : `${boundGoogleProjects} project(s) bound · ${runtimeHealth.failedSyncJobs} failed sync job(s) · ${runtimeHealth.failedSyncDates} failed date(s).`,
      actionHref: "/projects",
      actionLabel: t("Projects", "Projeler"),
    },
    {
      label: t("Agent UAT smoke gate", "Agent UAT smoke gate"),
      ready: uatSmokeReady,
      detail: `${directUatAgents.size}/7 specialist agents have a passing direct scenario · ${routerUatPasses}/3 minimum router scenarios passed.`,
      actionHref: "/agent-uat",
      actionLabel: "Agent UAT",
    },
    {
      label: t("Production cost guardrail", "Production maliyet guardrail'i"),
      ready: Boolean(budgetLimits),
      detail: budgetLimits
        ? `${budgetLimits} project/category monthly budget limit(s) configured with deterministic soft/hard budget findings.`
        : "Configure at least one AI/SERP/browser monthly budget before production model or paid-provider testing.",
      actionHref: "/costs",
      actionLabel: t("Costs & Budgets", "Maliyet & Bütçeler"),
    },
  ];

  const specialistItems: ReadinessItem[] = [
    {
      label: t("Research / SERP provider", "Araştırma / SERP provider"),
      ready: dataForSeoReady,
      optional: true,
      detail: dataForSeoReady
        ? "DataForSEO live SERP evidence available."
        : "Optional: add DataForSEO credentials for live SERP/competitor research.",
    },
    {
      label: t("Developer private GitHub access", "Developer private GitHub erişimi"),
      ready: githubPrivateReady,
      optional: true,
      detail: githubPrivateReady
        ? "Private repository read context available."
        : "Public repos work without a token; private repos need GITHUB_TOKEN.",
    },
    {
      label: t("Global Brain", "Global Brain"),
      ready: Boolean(brainEntries),
      detail: `${brainEntries || 0} active organization-wide context entries.`,
      actionHref: "/brain",
      actionLabel: t("Global Brain", "Global Brain"),
    },
    {
      label: t("Technical crawl automation", "Technical crawl otomasyonu"),
      ready: deterministicWorkerReady,
      optional: true,
      detail: deterministicWorkerReady
        ? `${activeTechnicalSchedules || 0} active deterministic crawl schedule(s).`
        : `${activeTechnicalSchedules || 0} schedules configured; activation waits for worker secrets.`,
      actionHref: "/automations",
      actionLabel: t("Automations", "Otomasyonlar"),
    },
    {
      label: t("Sales discovery automation", "Satış keşif otomasyonu"),
      ready: salesWorkerReady,
      optional: true,
      detail: salesWorkerReady
        ? `${activeSalesAutomations || 0} automated Sales campaign(s) can run.`
        : `${activeSalesAutomations || 0} campaigns configured; DataForSEO + worker credentials are required.`,
      actionHref: "/sales",
      actionLabel: "Sales",
    },
    {
      label: t("Rank tracking automation", "Rank tracking otomasyonu"),
      ready: rankWorkerReady,
      optional: true,
      detail: rankWorkerReady
        ? `${activeRankProjects || 0} project(s) have active Rank Tracking.`
        : `${activeRankProjects || 0} project(s) configured; DataForSEO + worker credentials are required.`,
      actionHref: "/automations",
      actionLabel: t("Automations", "Otomasyonlar"),
    },
    {
      label: t("Automatic Opportunity Engine", "Otomatik Opportunity Engine"),
      ready: opportunityWorkerReady,
      optional: true,
      detail: opportunityWorkerReady
        ? `${activeOpportunityProjects || 0} project(s) can scan warehouse evidence automatically.`
        : `${activeOpportunityProjects || 0} project(s) configured; worker credentials are required.`,
      actionHref: "/opportunities",
      actionLabel: t("Intelligence Inbox", "İçgörü Kutusu"),
    },
    {
      label: t("SEO Intervention Monitoring", "SEO Intervention Monitoring"),
      ready: interventionWorkerReady,
      optional: true,
      detail: interventionWorkerReady
        ? `${monitoringInterventions || 0} intervention(s) monitoring · ${pendingInterventionChecks || 0} pending checkpoint(s).`
        : `${monitoringInterventions || 0} intervention(s) configured · ${pendingInterventionChecks || 0} pending checkpoint(s); worker credentials are required for automatic evaluation.`,
      actionHref: "/automations",
      actionLabel: t("Automations", "Otomasyonlar"),
    },
    {
      label: t("Native deliverables", "Native çıktılar"),
      ready: true,
      detail: `${outputs || 0} generated output(s) stored. Documents can render as DOCX and presentations as PPTX without another model call.`,
      actionHref: "/outputs",
      actionLabel: t("Outputs", "Çıktılar"),
    },
    {
      label: t("Approval gate", "Onay katmanı"),
      ready: true,
      detail: `${pendingApprovals || 0} pending actions. External-impact proposals require explicit approval.`,
      actionHref: "/approvals",
      actionLabel: t("Approval Center", "Onay Merkezi"),
    },
    {
      label: t("Technical evidence layer", "Teknik kanıt katmanı"),
      ready: true,
      detail: `${crawlRuns || 0} crawl runs stored. Raw HTTP V2 includes internal link graph, depth/inlinks, sitemap/orphan evidence, delta regressions, canonical target checks and hreflang graph validation.`,
      actionHref: "/automations",
      actionLabel: t("Crawler automations", "Crawler otomasyonları"),
    },
    {
      label: t("Persistent outputs", "Kalıcı çıktılar"),
      ready: true,
      detail: `${outputs || 0} generated deliverables stored.`,
      actionHref: "/outputs",
      actionLabel: t("Outputs", "Çıktılar"),
    },
  ];

  const requiredMissing = coreItems.filter((item) => !item.ready && !item.optional).length;
  const testingAgents = (agents || []).filter((agent) => ["testing", "active"].includes(agent.status)).length;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{t("Launch checklist", "Launch kontrol listesi")}</p>
          <h1>{t("System Readiness", "Sistem Hazırlığı")}</h1>
          <p className="muted">
            {t(
              "See what is connected, healthy and still blocking autonomous operation.",
              "Hangi katmanların bağlı ve sağlıklı olduğunu, nelerin otonom çalışmayı engellediğini tek yerde gör.",
            )}
          </p>
        </div>
        <div className={requiredMissing ? "readinessHero readinessHeroWarn" : "readinessHero readinessHeroReady"}>
          <strong>
            {requiredMissing
              ? requiredMissing + " " + t("blocker(s)", "engel")
              : t("Core ready", "Core hazır")}
          </strong>
          <span>
            {testingAgents} {t("agents installed for testing", "agent test için kurulu")}
          </span>
        </div>
      </header>

      <section className="healthGrid readinessStats">
        <article className="healthCard">
          <span>{t("Active projects", "Aktif projeler")}</span>
          <strong>{projects || 0}</strong>
          <small>{t("Owned + client + lead", "Kendi + müşteri + potansiyel")}</small>
        </article>
        <article className="healthCard">
          <span>{t("Agent team", "Agent ekibi")}</span>
          <strong>{testingAgents}</strong>
          <small>{t("Testing / active", "Test / aktif")}</small>
        </article>
        <article className="healthCard">
          <span>{t("Scheduled work", "Zamanlanmış işler")}</span>
          <strong>{totalScheduled}</strong>
          <small>
            {activeSchedules || 0} agent · {activeTechnicalSchedules || 0} crawl · {activeSalesAutomations || 0} sales · {activeRankProjects || 0} rank · {activeOpportunityProjects || 0} intelligence · {monitoringInterventions || 0} interventions
          </small>
        </article>
        <article className="healthCard">
          <span>{t("Pending approvals", "Bekleyen onaylar")}</span>
          <strong>{pendingApprovals || 0}</strong>
          <small>{t("Human gate", "İnsan onayı")}</small>
        </article>
        <article className="healthCard">
          <span>{t("Failed jobs", "Hatalı işler")}</span>
          <strong className={failedJobs ? "healthBad" : "healthGood"}>{failedJobs || 0}</strong>
          <small>{t("Needs review", "İnceleme gerekiyor")}</small>
        </article>
        <article className="healthCard">
          <span>{t("Repo bindings", "Repo bağlantıları")}</span>
          <strong>{repositoryBindings || 0}</strong>
          <small>{t("Developer context", "Developer context")}</small>
        </article>
        <article className="healthCard">
          <span>{t("Warehouse queue", "Warehouse kuyruğu")}</span>
          <strong>{runtimeHealth.queuedSyncJobs + runtimeHealth.runningSyncJobs}</strong>
          <small>{runtimeHealth.queuedSyncJobs} queued · {runtimeHealth.runningSyncJobs} running · {runtimeHealth.failedSyncJobs} failed</small>
        </article>
        <article className="healthCard">
          <span>{t("Worker operations", "Worker operasyonları")}</span>
          <strong>{runtimeHealth.recentWorkerRuns}</strong>
          <small>{t("Owner-scoped runs · last 24h", "Owner scoped çalışmalar · son 24 sa")}</small>
        </article>
        <article className="healthCard">
          <span>{t("Stale workers", "Takılı worker'lar")}</span>
          <strong className={staleWorkerCount ? "healthBad" : "healthGood"}>{staleWorkerCount}</strong>
          <small>{t("Auto-recovery candidates", "Auto recovery adayları")}</small>
        </article>
      </section>

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>{t("Core launch requirements", "Core launch gereksinimleri")}</h2>
              <p>{t("These determine whether the full runtime can operate.", "Tam runtime'ın çalışıp çalışamayacağını bunlar belirler.")}</p>
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
                  <span className={`readinessBadge ${statusClass(item)}`}>{statusLabel(item, tr)}</span>
                  {item.actionHref ? <Link href={item.actionHref}>{item.actionLabel}</Link> : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>{t("Specialist capabilities", "Uzman yetenekler")}</h2>
              <p>{t("Optional providers and evidence layers.", "Opsiyonel provider ve kanıt katmanları.")}</p>
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
                  <span className={`readinessBadge ${statusClass(item)}`}>{statusLabel(item, tr)}</span>
                  {item.actionHref ? <Link href={item.actionHref}>{item.actionLabel}</Link> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel readinessLaunchPanel">
        <div>
          <h2>{t("Activation order", "Aktivasyon sırası")}</h2>
          <p>
            {tr
              ? "1. Production environment değişkenlerini doğrula. 2. Supabase pg_cron worker tetiklemelerini doğrula. 3. Kontrollü bir projede Agent UAT smoke testini çalıştır. 4. En az bir worker döngüsü boyunca Operations ve Data Health temiz kalsın. 5. Supabase leaked-password protection'ı etkinleştir. 6. Son olarak dış etkili executor'ları approval gate arkasında aktive et."
              : "1. Verify production environment variables. 2. Confirm Supabase pg_cron can invoke protected worker routes. 3. Run Agent UAT on a controlled project. 4. Keep Operations and Data Health clean through a full worker cycle. 5. Enable Supabase leaked-password protection. 6. Only then activate external-impact executors behind the approval gate."}
          </p>
        </div>
        <div className="buttonRow">
          <Link href="/team" className="secondaryButton">{t("Team Room", "Ekip Odası")}</Link>
          <Link href="/command" className="primaryButton">{t("Chief Operator", "Chief Operator")}</Link>
        </div>
      </section>
    </div>
  );
}
