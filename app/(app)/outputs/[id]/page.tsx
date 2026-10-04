import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function OutputDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: output } = await supabase
    .from("generated_outputs")
    .select("id,project_id,agent_run_id,output_type,title,status,body_markdown,data,created_at")
    .eq("id", id)
    .maybeSingle();

  if (!output) notFound();

  const { data: project } = await supabase
    .from("projects")
    .select("name,domain")
    .eq("id", output.project_id)
    .maybeSingle();

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{project?.name || "Project"} · {output.output_type}</p>
          <h1>{output.title}</h1>
          <p className="muted">{new Date(output.created_at).toLocaleString("en-GB")} · {output.status}</p>
        </div>
        <div className="buttonRow">
          <a className="primaryButton" href={`/api/outputs/${output.id}/download`}>Download .md</a>
          <Link className="ghostButton" href="/outputs">Back</Link>
        </div>
      </header>

      <section className="panel outputDocument">
        <pre>{output.body_markdown || JSON.stringify(output.data, null, 2)}</pre>
      </section>
    </div>
  );
}
