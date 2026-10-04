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

  const data = (output.data || {}) as {
    deliverable_contract?: {
      type?: string;
      slides?: Array<{
        slide_type?: string;
        title?: string;
        key_message?: string;
        bullets?: string[];
        evidence_refs?: string[];
      }>;
    };
    output_profile_rules?: Record<string, unknown> | null;
    output_profile_strict?: boolean;
  };

  const slides =
    data.deliverable_contract?.type === "presentation_slide_plan"
      ? data.deliverable_contract.slides || []
      : [];

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

      {slides.length ? (
        <>
          <section className="outputContractBar">
            <div>
              <strong>Presentation contract</strong>
              <span>{data.output_profile_strict ? "Strict profile" : "Flexible profile"}</span>
            </div>
            <div>
              <strong>Slides</strong>
              <span>{slides.length}</span>
            </div>
            <div>
              <strong>Renderer</strong>
              <span>Master-template mapping pending</span>
            </div>
          </section>

          <section className="slidePlanGrid">
            {slides.map((slide, index) => (
              <article className="slidePlanCard" key={index}>
                <div className="slidePlanTop">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{slide.slide_type || "slide"}</strong>
                </div>
                <h2>{slide.title || "Untitled slide"}</h2>
                <p>{slide.key_message || "No primary message."}</p>
                {slide.bullets?.length ? (
                  <ul>
                    {slide.bullets.map((bullet, bulletIndex) => (
                      <li key={bulletIndex}>{bullet}</li>
                    ))}
                  </ul>
                ) : null}
                {slide.evidence_refs?.length ? (
                  <div className="slideEvidence">
                    <strong>Evidence</strong>
                    <span>{slide.evidence_refs.join(" · ")}</span>
                  </div>
                ) : null}
              </article>
            ))}
          </section>
        </>
      ) : null}

      <section className="panel outputDocument">
        <pre>{output.body_markdown || JSON.stringify(output.data, null, 2)}</pre>
      </section>
    </div>
  );
}
