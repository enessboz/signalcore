import Link from "next/link";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type Check = {
  label: string;
  ready: boolean;
  required: boolean;
  detail: string;
};

function checkClass(check: Check) {
  if (check.ready) return "readinessReady";
  if (!check.required) return "readinessOptional";
  return "readinessRequired";
}

export default async function PreflightPage() {
  const supabase = await createClient();
  const requestHeaders = await headers();
  const forwardedProto = requestHeaders.get("x-forwarded-proto") || "https";
  const forwardedHost =
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "";
  const requestOrigin = forwardedHost
    ? forwardedProto + "://" + forwardedHost
    : "";
  const appUrl = (process.env.APP_URL || requestOrigin).replace(/\/$/, "");
  const oauthCallback = appUrl
    ? appUrl + "/api/connections/google/callback"
    : "/api/connections/google/callback";

  const envChecks: Check[] = [
    {
      label: "Supabase public URL",
      ready: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      required: true,
      detail: "NEXT_PUBLIC_SUPABASE_URL",
    },
    {
      label: "Supabase publishable key",
      ready: Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
      required: true,
      detail: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    },
    {
      label: "Supabase service role",
      ready: Boolean(process.env.SUPABASE_SECRET_KEY),
      required: true,
      detail: "SUPABASE_SECRET_KEY",
    },
    {
      label: "Cron protection",
      ready: Boolean(process.env.CRON_SECRET),
      required: true,
      detail: "CRON_SECRET",
    },
    {
      label: "OpenAI runtime",
      ready: Boolean(process.env.OPENAI_API_KEY),
      required: true,
      detail: "OPENAI_API_KEY",
    },
    {
      label: "Google OAuth client",
      ready: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
      ),
      required: true,
      detail: "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET",
    },
    {
      label: "Credential encryption",
      ready: Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY),
      required: true,
      detail: "CREDENTIAL_ENCRYPTION_KEY",
    },
    {
      label: "Stable production URL",
      ready: Boolean(process.env.APP_URL),
      required: false,
      detail:
        "APP_URL is recommended so OAuth always resolves to the intended production domain.",
    },
    {
      label: "DataForSEO",
      ready: Boolean(
        process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
      ),
      required: false,
      detail: "Required only for paid rank tracking, SERP research and Sales Discovery.",
    },
    {
      label: "PageSpeed / Core Web Vitals",
      ready: Boolean(process.env.PAGESPEED_API_KEY),
      required: false,
      detail:
        "PAGESPEED_API_KEY enables selective PSI samples after crawl completion.",
    },
    {
      label: "Selective JS renderer",
      ready: Boolean(process.env.JS_RENDER_ENDPOINT),
      required: false,
      detail:
        "JS_RENDER_ENDPOINT enables headless rendering fallback. JS_RENDER_TOKEN is optional depending on the provider.",
    },
    {
      label: "Private GitHub context",
      ready: Boolean(process.env.GITHUB_TOKEN),
      required: false,
      detail: "Required only for private repository reads.",
    },
  ];

  const criticalTables = [
    "projects",
    "agent_definitions",
    "runtime_worker_runs",
    "agent_uat_runs",
    "google_sync_date_log",
    "generated_outputs",
    "budget_limits",
    "approvals",
    "crawl_url_queue",
    "crawl_robots_audits",
    "crawl_performance_queue",
    "crawl_performance_results",
    "crawl_finding_reviews",
  ] as const;

  const tableResults = await Promise.all(
    criticalTables.map(async (table) => {
      const { error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });
      return {
        table,
        ready: !error,
        error: error?.message || null,
      };
    }),
  );

  const schemaChecks: Check[] = tableResults.map((result) => ({
    label: result.table,
    ready: result.ready,
    required: true,
    detail: result.ready
      ? "RLS-scoped query succeeded."
      : result.error || "Schema check failed.",
  }));

  let serviceRoleReady = false;
  let serviceRoleDetail =
    "SUPABASE_SECRET_KEY is not configured in this deployment.";

  if (process.env.SUPABASE_SECRET_KEY) {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("runtime_leases")
        .select("lease_key", { count: "exact", head: true });
      serviceRoleReady = !error;
      serviceRoleDetail = error
        ? error.message
        : "Service-role database query succeeded.";
    } catch (error) {
      serviceRoleDetail =
        error instanceof Error ? error.message : "Service-role check failed.";
    }
  }

  const runtimeChecks: Check[] = [
    {
      label: "Service-role database access",
      ready: serviceRoleReady,
      required: true,
      detail: serviceRoleDetail,
    },
    {
      label: "Google OAuth callback",
      ready: Boolean(appUrl),
      required: true,
      detail: oauthCallback,
    },
    {
      label: "Protected worker routes",
      ready: Boolean(process.env.CRON_SECRET && process.env.SUPABASE_SECRET_KEY),
      required: true,
      detail:
        "Production workers are scheduled by Supabase pg_cron and authenticate to the protected Vercel worker routes with CRON_SECRET. Vercel Cron is intentionally unused on the Hobby plan.",
    },
  ];

  const allChecks = [...envChecks, ...schemaChecks, ...runtimeChecks];
  const requiredMissing = allChecks.filter(
    (check) => check.required && !check.ready,
  ).length;
  const optionalMissing = allChecks.filter(
    (check) => !check.required && !check.ready,
  ).length;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Deployment verification</p>
          <h1>Production Preflight</h1>
          <p className="muted">
            Safe presence/connectivity checks for the final Vercel deployment.
            Secret values are never rendered.
          </p>
        </div>
        <div
          className={
            requiredMissing
              ? "readinessHero readinessHeroWarn"
              : "readinessHero readinessHeroReady"
          }
        >
          <strong>
            {requiredMissing
              ? requiredMissing + " blocker(s)"
              : "Preflight ready"}
          </strong>
          <span>{optionalMissing} optional integration(s) unavailable</span>
        </div>
      </header>

      <section className="healthGrid">
        <article className="healthCard">
          <span>Required checks</span>
          <strong>
            {allChecks.filter((check) => check.required && check.ready).length}
            {" / "}
            {allChecks.filter((check) => check.required).length}
          </strong>
          <small>Must pass before production activation</small>
        </article>
        <article className="healthCard">
          <span>Critical schema</span>
          <strong>
            {schemaChecks.filter((check) => check.ready).length}
            {" / "}
            {schemaChecks.length}
          </strong>
          <small>RLS-scoped table availability</small>
        </article>
        <article className="healthCard">
          <span>Service role</span>
          <strong className={serviceRoleReady ? "healthGood" : "healthBad"}>
            {serviceRoleReady ? "Ready" : "Blocked"}
          </strong>
          <small>Background worker database access</small>
        </article>
        <article className="healthCard">
          <span>Production origin</span>
          <strong>{appUrl ? "Resolved" : "Missing"}</strong>
          <small>{appUrl || "No deployment origin resolved"}</small>
        </article>
      </section>

      <div className="twoCol dataTwoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Environment</h2>
              <p>Presence checks only.</p>
            </div>
          </div>
          <div className="readinessList">
            {envChecks.map((check) => (
              <div className="readinessRow" key={check.label}>
                <div className={"readinessIcon " + checkClass(check)}>
                  {check.ready ? "✓" : check.required ? "!" : "○"}
                </div>
                <div className="readinessCopy">
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
                <div className="readinessRowActions">
                  <span className={"readinessBadge " + checkClass(check)}>
                    {check.ready ? "Ready" : check.required ? "Required" : "Optional"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Runtime</h2>
              <p>Deployment-level server checks.</p>
            </div>
          </div>
          <div className="readinessList">
            {runtimeChecks.map((check) => (
              <div className="readinessRow" key={check.label}>
                <div className={"readinessIcon " + checkClass(check)}>
                  {check.ready ? "✓" : "!"}
                </div>
                <div className="readinessCopy">
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
                <div className="readinessRowActions">
                  <span className={"readinessBadge " + checkClass(check)}>
                    {check.ready ? "Ready" : "Required"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Critical database schema</h2>
            <p>
              These checks run through the signed-in user session so RLS behavior is
              included in the verification.
            </p>
          </div>
        </div>
        <div className="readinessList">
          {schemaChecks.map((check) => (
            <div className="readinessRow" key={check.label}>
              <div className={"readinessIcon " + checkClass(check)}>
                {check.ready ? "✓" : "!"}
              </div>
              <div className="readinessCopy">
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
              <div className="readinessRowActions">
                <span className={"readinessBadge " + checkClass(check)}>
                  {check.ready ? "Ready" : "Required"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel readinessLaunchPanel">
        <div>
          <h2>After the final Vercel switch</h2>
          <p>
            Run this page first, then complete Agent UAT smoke tests and confirm one
            clean Operations cycle before enabling production external-impact actions.
          </p>
        </div>
        <div className="buttonRow">
          <Link href="/readiness" className="secondaryButton">System Readiness</Link>
          <Link href="/operations" className="primaryButton">Operations</Link>
        </div>
      </section>
    </div>
  );
}
