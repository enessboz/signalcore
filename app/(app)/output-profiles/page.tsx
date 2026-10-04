import { createClient } from "@/lib/supabase/server";
import {
  assignProjectOutputProfile,
  createOutputProfile,
  setDefaultOutputProfile,
  toggleOutputProfile,
} from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;
function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

export default async function OutputProfilesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const supabase = await createClient();

  const [
    { data: profiles },
    { data: projects },
    { data: assignments },
  ] = await Promise.all([
    supabase
      .from("output_profiles")
      .select("id,profile_key,name,output_type,description,strict_mode,is_default,active,rules,template_metadata,updated_at")
      .order("output_type")
      .order("is_default", { ascending: false })
      .order("name"),
    supabase
      .from("projects")
      .select("id,name,project_type")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("project_output_profiles")
      .select("project_id,output_type,profile_id"),
  ]);

  const types = ["summary","document","presentation","task","email"] as const;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Strict output governance</p>
          <h1>Output Profiles</h1>
          <p className="muted">
            Define the only rules and presentation/document structures Reporting Agent is allowed to use.
          </p>
        </div>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}

      <div className="twoCol">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Create profile</h2>
              <p>Rules use JSON so the renderer and Reporting Agent can consume the same contract.</p>
            </div>
          </div>
          <form className="formPanel" action={createOutputProfile}>
            <label>
              Output type
              <select name="outputType" defaultValue="presentation">
                {types.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>Name<input name="name" required placeholder="Impavo SEO Sales Presentation v1" /></label>
            <label>Description<input name="description" placeholder="What this profile is for" /></label>
            <label>
              Rules JSON
              <textarea
                name="rules"
                rows={14}
                defaultValue={JSON.stringify({
                  allowed_slide_types: ["title","executive_summary","opportunity","roadmap","next_steps"],
                  claims_policy: "Facts and estimates must remain distinct.",
                  forbidden: ["unsupported claims","arbitrary layouts"],
                }, null, 2)}
              />
            </label>
            <label className="checkboxLabel">
              <input type="checkbox" name="strictMode" defaultChecked />
              Strict mode
            </label>
            <label className="checkboxLabel">
              <input type="checkbox" name="isDefault" />
              Make default for this output type
            </label>
            <button className="primaryButton" type="submit">Create profile</button>
          </form>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Project overrides</h2>
              <p>Projects use the default profile unless an explicit override is assigned.</p>
            </div>
          </div>

          <form className="formPanel" action={assignProjectOutputProfile}>
            <label>
              Project
              <select name="projectId" required defaultValue="">
                <option value="" disabled>Select project</option>
                {(projects || []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} · {project.project_type.replaceAll("_"," ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Output type
              <select name="outputType" defaultValue="presentation">
                {types.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              Profile
              <select name="profileId" defaultValue="">
                <option value="">Use default profile</option>
                {(profiles || []).filter((profile) => profile.active).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.output_type}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondaryButton" type="submit">Save project override</button>
          </form>

          <div className="profileAssignmentList">
            {(assignments || []).length ? (assignments || []).map((assignment) => {
              const project = (projects || []).find((item) => item.id === assignment.project_id);
              const profile = (profiles || []).find((item) => item.id === assignment.profile_id);
              return (
                <div className="profileAssignmentRow" key={`${assignment.project_id}-${assignment.output_type}`}>
                  <div>
                    <strong>{project?.name || "Project"}</strong>
                    <span>{assignment.output_type}</span>
                  </div>
                  <small>{profile?.name || "Unknown profile"}</small>
                </div>
              );
            }) : (
              <div className="emptyState smallEmpty"><span>No project-specific overrides yet.</span></div>
            )}
          </div>
        </section>
      </div>

      <section className="profileGrid">
        {(profiles || []).map((profile) => (
          <article className={profile.active ? "profileCard" : "profileCard inactive"} key={profile.id}>
            <div className="profileCardTop">
              <div>
                <p className="eyebrow">{profile.output_type}</p>
                <h3>{profile.name}</h3>
              </div>
              <div className="profileBadges">
                {profile.is_default ? <span className="confidence">default</span> : null}
                {profile.strict_mode ? <span className="sourceBadge">strict</span> : null}
              </div>
            </div>
            <p>{profile.description || "No description."}</p>
            <pre>{JSON.stringify(profile.rules, null, 2)}</pre>
            <div className="buttonRow">
              {!profile.is_default ? (
                <form action={setDefaultOutputProfile.bind(null, profile.id)}>
                  <button className="secondaryButton" type="submit">Set default</button>
                </form>
              ) : null}
              <form action={toggleOutputProfile.bind(null, profile.id, !profile.active)}>
                <button className="ghostButton" type="submit">{profile.active ? "Disable" : "Enable"}</button>
              </form>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
