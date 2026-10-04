import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const query = await searchParams;
  const supabase = await createClient();

  const { data: connection } = await supabase
    .from("connections")
    .select("id,status,external_account,scopes,last_discovery_at,last_error,config")
    .eq("provider", "google")
    .maybeSingle();

  let resources: Array<{
    id: string;
    resource_type: string;
    resource_id: string;
    display_name: string | null;
    permission_level: string | null;
    parent_id: string | null;
  }> = [];

  if (connection?.id) {
    const { data } = await supabase
      .from("connection_resources")
      .select("id,resource_type,resource_id,display_name,permission_level,parent_id")
      .eq("connection_id", connection.id)
      .eq("active", true)
      .order("resource_type")
      .order("display_name");
    resources = data || [];
  }

  const gscResources = resources.filter((resource) => resource.resource_type === "gsc_property");
  const ga4Resources = resources.filter((resource) => resource.resource_type === "ga4_property");

  const oauthConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.CREDENTIAL_ENCRYPTION_KEY,
  );

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">SignalCore</p>
          <h1>Settings</h1>
          <p className="muted">Account-level integrations, model routing, budgets and output rules.</p>
        </div>
      </header>

      {query.error ? <p className="formMessage formError pageMessage">{query.error}</p> : null}
      {query.message ? <p className="formMessage formSuccess pageMessage">{query.message}</p> : null}

      <section className="panel integrationPanel">
        <div className="panelHeader">
          <div>
            <h2>Google connection</h2>
            <p>Connect once, discover every accessible GSC and GA4 property, then bind them to projects.</p>
          </div>
          <span className={`connectionStatus connection-${connection?.status || "disconnected"}`}>
            {connection?.status || "disconnected"}
          </span>
        </div>

        {connection?.status === "connected" ? (
          <div className="integrationBody">
            <div className="integrationSummary">
              <div><strong>Google account</strong><span>{connection.external_account || "Connected account"}</span></div>
              <div><strong>GSC properties</strong><span>{gscResources.length}</span></div>
              <div><strong>GA4 properties</strong><span>{ga4Resources.length}</span></div>
            </div>

            {connection.last_discovery_at ? (
              <p className="muted">
                Last resource discovery: {new Date(connection.last_discovery_at).toLocaleString("en-GB")}
              </p>
            ) : null}

            {connection.last_error ? (
              <p className="formMessage formError">{connection.last_error}</p>
            ) : null}

            <div className="resourceColumns">
              <div className="resourceGroup">
                <div className="resourceGroupHeader">
                  <strong>Search Console</strong>
                  <span>{gscResources.length} resources</span>
                </div>
                <div className="resourceList">
                  {gscResources.slice(0, 8).map((resource) => (
                    <div className="resourceRow" key={resource.id}>
                      <span>{resource.display_name || resource.resource_id}</span>
                      <small>{resource.permission_level || "available"}</small>
                    </div>
                  ))}
                  {gscResources.length > 8 ? <small className="muted">+ {gscResources.length - 8} more</small> : null}
                </div>
              </div>

              <div className="resourceGroup">
                <div className="resourceGroupHeader">
                  <strong>Google Analytics 4</strong>
                  <span>{ga4Resources.length} resources</span>
                </div>
                <div className="resourceList">
                  {ga4Resources.slice(0, 8).map((resource) => (
                    <div className="resourceRow" key={resource.id}>
                      <span>{resource.display_name || resource.resource_id}</span>
                      <small>{resource.resource_id}</small>
                    </div>
                  ))}
                  {ga4Resources.length > 8 ? <small className="muted">+ {ga4Resources.length - 8} more</small> : null}
                </div>
              </div>
            </div>

            <Link className="secondaryButton inlineLink" href="/api/connections/google/connect">
              Reconnect & refresh Google resources
            </Link>
          </div>
        ) : oauthConfigured ? (
          <div className="integrationBody">
            <p className="muted">
              One Google consent flow will request read-only Search Console and Analytics access.
            </p>
            <Link className="primaryButton inlineLink" href="/api/connections/google/connect">
              Connect Google
            </Link>
          </div>
        ) : (
          <div className="integrationBody">
            <p className="formMessage formError">
              Google OAuth application credentials are not configured yet. The app code is ready; add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to Vercel.
            </p>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Connection model</h2>
            <p>Credentials belong to your SignalCore account, not individual projects.</p>
          </div>
        </div>
        <div className="foundationGrid">
          <div><strong>Google OAuth</strong><span>One account-level connection</span></div>
          <div><strong>Resource discovery</strong><span>GSC + GA4 properties</span></div>
          <div><strong>Project binding</strong><span>Select the right property per project</span></div>
          <div><strong>Permissions</strong><span>Read-only scopes in V1</span></div>
        </div>
      </section>
    </div>
  );
}
