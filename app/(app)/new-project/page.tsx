import { createProject } from "./actions";

const types = [
  ["owned", "Owned Project", "Full internal context can be stored when access exists."],
  ["client", "Client Project", "Bounded memory: only supplied, connected or explicitly known client context."],
  ["lead_prospect", "Lead Prospect", "Public and licensed third-party evidence only; no private analytics claims."],
] as const;

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="page narrowPage">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Create workspace</p>
          <h1>New project</h1>
          <p className="muted">Start with the knowledge boundary. Integrations come after the project exists.</p>
        </div>
      </header>

      <form className="panel formPanel" action={createProject}>
        {params.error ? <p className="formMessage formError">{params.error}</p> : null}
        <label>Project name<input name="name" placeholder="e.g. EatBetter" required /></label>
        <label>Domain<input name="domain" placeholder="example.com" /></label>

        <fieldset>
          <legend>Project type</legend>
          <div className="typeGrid">
            {types.map(([value, name, desc]) => (
              <label className="typeCard" key={value}>
                <input type="radio" name="projectType" value={value} required />
                <strong>{name}</strong>
                <span>{desc}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          Initial background
          <textarea
            name="description"
            rows={5}
            placeholder="Optional short context. Full LLM Background files will be added after the project is created."
          />
        </label>

        <button className="primaryButton" type="submit">Create project</button>
      </form>
    </div>
  );
}
