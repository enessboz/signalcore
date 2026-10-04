import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectTypeBadge } from "@/components/project-type-badge";
import { ProjectDataNav } from "@/components/project-data-nav";
import { createClient } from "@/lib/supabase/server";
import type { ProjectType } from "@/lib/domain/types";
import { addBackgroundSource, bindGoogleResource, convertProjectToClient, queueGoogleBackfill, setGoogleAutoSync } from "./actions";

type Resource = {
  id: string;
  connection_id: string;
  resource_type: "gsc_property" | "ga4_property";
  resource_id: string;
  display_name: string | null;
  permission_level: string | null;
  parent_id: string | null;
};

type Binding = {
  id: string;
  binding_type: "gsc" | "ga4";
  resource_id: string;
  auto_sync_enabled: boolean;
};

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("*").eq("id", id).single();

  if (!project) notFound();

  const [
    { count: sources },
    { count: facts },
    { count: findings },
    { count: jobs },
    { count: chunks },
    { data: recentSources },
    { data: googleConnection },
    { data: resources },
    { data: bindings },
    { data: syncStates },
    { data: syncQueue },
  ] = await Promise.all([
    supabase.from("project_sources").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("project_facts").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("findings").select("id", { count: "exact", head: true }).eq("project_id", id).neq("status", "resolved"),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("background_chunks").select("id", { count: "exact", head: true }).eq("project_id", id),
    supabase.from("project_sources").select("id,title,source_type,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(6),
    supabase
      .from("connections")
      .select("id,status,external_account,last_discovery_at,last_error")
      .eq("provider", "google")
      .maybeSingle(),
    supabase
      .from("connection_resources")
      .select("id,connection_id,resource_type,resource_id,display_name,permission_level,parent_id")
      .eq("active", true)
      .order("resource_type")
      .order("display_name"),
    supabase
      .from("project_bindings")
      .select("id,binding_type,resource_id,auto_sync_enabled")
      .eq("project_id", id),
    supabase
      .from("google_sync_states")
      .select("source,dataset,status,last_complete_date,last_success_at,rows_total,last_error")
      .eq("project_id", id)
      .order("source")
      .order("dataset"),
    supabase
      .from("google_sync_queue")
      .select("id,source,mode,start_date,end_date,cursor_date,status,error,created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  const googleResources = (resources || []) as Resource[];
  const projectBindings = (bindings || []) as Binding[];
  const gscResources = googleResources.filter((resource) => resource.resource_type === "gsc_property");
  const ga4Resources = googleResources.filter((resource) => resource.resource_type === "ga4_property");
  const gscBinding = projectBindings.find((binding) => binding.binding_type === "gsc");
  const ga4Binding = projectBindings.find((binding) => binding.binding_type === "ga4");

  const addSource = addBackgroundSource.bind(null, id);
  const bindGsc = bindGoogleResource.bind(null, id, "gsc");
  const bindGa4 = bindGoogleResource.bind(null, id, "ga4");
  const queueGscBackfill = queueGoogleBackfill.bind(null, id, "gsc");
  const queueGa4Backfill = queueGoogleBackfill.bind(null, id, "ga4");

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Project workspace</p>
          <h1>{project.name}</h1>
          <p className="muted">{project.domain || "Domain not configured"}</p>
        </div>
        <div className="buttonRow">
          <ProjectTypeBadge type={project.project_type as ProjectType} />
          {project.project_type === "lead_prospect" ? (
            <form action={convertProjectToClient.bind(null, id)}>
              <button className="primaryButton" type="submit">Convert to Client</button>
            </form>
          ) : null}
        </div>
      </header>

      <ProjectDataNav projectId={id} active="overview" />

      {query.error ? <p className="formMessage formError pageMessage">{query.error}</p> : null}
      {query.message ? <p className="formMessage formSuccess pageMessage">{query.message}</p> : null}

      <section className="statsGrid">
        <article className="statCard"><span>Sources</span><strong>{sources || 0}</strong><small>Project Brain inputs</small></article>
        <article className="statCard"><span>Chunks</span><strong>{chunks || 0}</strong><small>Searchable background segments</small></article>
        <article className="statCard"><span>Open findings</span><strong>{findings || 0}</strong><small>Issues + opportunities</small></article>
        <article className="statCard"><span>Jobs</span><strong>{jobs || 0}</strong><small>Manual + scheduled runs</small></article>
      </section>

      <section className="panel integrationPanel">
        <div className="panelHeader">
          <div>
            <h2>Google data sources</h2>
            <p>Google is connected once at account level; choose the resources this project should use.</p>
          </div>
          <span className={`connectionStatus connection-${googleConnection?.status || "disconnected"}`}>
            {googleConnection?.status || "disconnected"}
          </span>
        </div>

        {googleConnection?.status === "connected" ? (
          <div className="integrationBody">
            <div className="integrationSummary">
              <div><strong>Google account</strong><span>{googleConnection.external_account || "Connected"}</span></div>
              <div><strong>Available GSC</strong><span>{gscResources.length}</span></div>
              <div><strong>Available GA4</strong><span>{ga4Resources.length}</span></div>
            </div>

            {googleConnection.last_error ? (
              <p className="formMessage formError">{googleConnection.last_error}</p>
            ) : null}

            <div className="bindingGrid">
              <form className="bindingCard" action={bindGsc}>
                <div>
                  <strong>Google Search Console</strong>
                  <span>Search performance, queries, pages, clicks, impressions and position.</span>
                </div>
                <label>
                  Property
                  <select name="resourceId" defaultValue={gscBinding?.resource_id || ""}>
                    <option value="">Not connected to this project</option>
                    {gscResources.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.display_name || resource.resource_id}
                        {resource.permission_level ? ` — ${resource.permission_level}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondaryButton" type="submit">Save GSC property</button>
              </form>

              <form className="bindingCard" action={bindGa4}>
                <div>
                  <strong>Google Analytics 4</strong>
                  <span>Landing-page, session, engagement and conversion metrics.</span>
                </div>
                <label>
                  Property
                  <select name="resourceId" defaultValue={ga4Binding?.resource_id || ""}>
                    <option value="">Not connected to this project</option>
                    {ga4Resources.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.display_name || resource.resource_id} — {resource.resource_id}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondaryButton" type="submit">Save GA4 property</button>
              </form>
            </div>

            <div className="syncControlGrid">
              <div className="syncControlCard">
                <div>
                  <strong>GSC warehouse sync</strong>
                  <span>
                    {gscBinding
                      ? gscBinding.auto_sync_enabled
                        ? "Auto sync enabled"
                        : "Property connected · auto sync off"
                      : "Select a GSC property first"}
                  </span>
                </div>
                <div className="buttonRow">
                  {gscBinding ? (
                    <form action={setGoogleAutoSync.bind(null, id, "gsc", !gscBinding.auto_sync_enabled)}>
                      <button className="secondaryButton" type="submit">
                        {gscBinding.auto_sync_enabled ? "Disable Auto Sync" : "Enable Auto Sync"}
                      </button>
                    </form>
                  ) : null}
                </div>
                {gscBinding ? (
                  <form className="syncBackfillForm" action={queueGscBackfill}>
                    <label>
                      Backfill
                      <select name="days" defaultValue="90">
                        <option value="30">30 days</option>
                        <option value="90">90 days</option>
                        <option value="180">180 days</option>
                        <option value="480">Approx. 16 months</option>
                      </select>
                    </label>
                    <button className="ghostButton" type="submit">Queue GSC backfill</button>
                  </form>
                ) : null}
              </div>

              <div className="syncControlCard">
                <div>
                  <strong>GA4 warehouse sync</strong>
                  <span>
                    {ga4Binding
                      ? ga4Binding.auto_sync_enabled
                        ? "Auto sync enabled"
                        : "Property connected · auto sync off"
                      : "Select a GA4 property first"}
                  </span>
                </div>
                <div className="buttonRow">
                  {ga4Binding ? (
                    <form action={setGoogleAutoSync.bind(null, id, "ga4", !ga4Binding.auto_sync_enabled)}>
                      <button className="secondaryButton" type="submit">
                        {ga4Binding.auto_sync_enabled ? "Disable Auto Sync" : "Enable Auto Sync"}
                      </button>
                    </form>
                  ) : null}
                </div>
                {ga4Binding ? (
                  <form className="syncBackfillForm" action={queueGa4Backfill}>
                    <label>
                      Backfill
                      <select name="days" defaultValue="90">
                        <option value="30">30 days</option>
                        <option value="90">90 days</option>
                        <option value="180">180 days</option>
                      </select>
                    </label>
                    <button className="ghostButton" type="submit">Queue GA4 backfill</button>
                  </form>
                ) : null}
              </div>
            </div>

            {(syncStates?.length || syncQueue?.length) ? (
              <div className="syncStatusPanel">
                <div className="syncStateList">
                  {(syncStates || []).map((state) => (
                    <div className="syncStateRow" key={`${state.source}-${state.dataset}`}>
                      <div>
                        <strong>{state.source.toUpperCase()} · {state.dataset.replaceAll("_", " ")}</strong>
                        <span>{state.last_complete_date || "No completed date yet"}</span>
                      </div>
                      <small className={`jobStatus job-${state.status}`}>{state.status}</small>
                    </div>
                  ))}
                </div>

                {(syncQueue || []).length ? (
                  <div className="syncQueueList">
                    {(syncQueue || []).map((job) => (
                      <div className="syncQueueRow" key={job.id}>
                        <span>{job.source.toUpperCase()} · {job.mode}</span>
                        <strong>{job.start_date} → {job.end_date}</strong>
                        <small className={`jobStatus job-${job.status}`}>{job.status}</small>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="buttonRow">
              <Link href={`/projects/${id}/search-console`} className="secondaryButton inlineLink">
                Open Search Console
              </Link>
              <Link href={`/projects/${id}/analytics`} className="secondaryButton inlineLink">
                Open GA4 Analytics
              </Link>
              <Link href="/settings" className="ghostButton inlineLink">
                Manage Google connection
              </Link>
            </div>
          </div>
        ) : (
          <div className="integrationBody">
            <p className="muted">
              No account-level Google connection is available yet. Connect Google once in Settings,
              then return here to bind the correct GSC and GA4 properties.
            </p>
            <Link href="/settings" className="primaryButton inlineLink">
              Open integration settings
            </Link>
          </div>
        )}
      </section>

      <div className="twoCol">
        <section className="panel">
          <div className="panelHeader">
            <div><h2>Add Project Brain source</h2><p>Manual background is stored as a source and chunked deterministically.</p></div>
          </div>
          <form className="formPanel" action={addSource}>
            <label>Source title<input name="title" placeholder="e.g. EatBetter SEO Background — October 2026" required /></label>
            <label>Background text<textarea name="content" rows={12} placeholder="Paste project background, known SEO history, client-provided context, rules or decisions." required /></label>
            <button className="primaryButton" type="submit">Add to Project Brain</button>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div><h2>Recent sources</h2><p>Source history remains separate from AI interpretations.</p></div>
          </div>
          {recentSources?.length ? (
            <div className="sourceList">
              {recentSources.map((source) => (
                <article className="sourceRow" key={source.id}>
                  <div><strong>{source.title}</strong><span>{source.source_type.replaceAll("_", " ")}</span></div>
                  <small>{new Date(source.created_at).toLocaleDateString("en-GB")}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className="emptyState smallEmpty"><strong>No background sources yet</strong><span>Add the first LLM Background or project note.</span></div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panelHeader"><div><h2>Project Brain status</h2><p>Retrieval is deterministic full-text in this milestone; embeddings/LLM extraction come later.</p></div></div>
        <div className="foundationGrid">
          <div><strong>Boundary</strong><span>{project.project_type}</span></div>
          <div><strong>Verified facts</strong><span>{facts || 0}</span></div>
          <div><strong>GSC binding</strong><span>{gscBinding ? "Connected" : "Not selected"}</span></div>
          <div><strong>GA4 binding</strong><span>{ga4Binding ? "Connected" : "Not selected"}</span></div>
        </div>
      </section>
    </div>
  );
}
