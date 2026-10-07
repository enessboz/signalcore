import { NextResponse } from "next/server";
import { renderDocx, renderPptx } from "@/lib/outputs/native-renderers";
import { createClient } from "@/lib/supabase/server";

function safeFileName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "signalcore-output";
}

type DownloadFormat = "md" | "docx" | "pptx";

function requestedFormat(request: Request, outputType: string | null | undefined) {
  const format = new URL(request.url).searchParams.get("format");
  if (format === "md" || format === "docx" || format === "pptx") {
    return format as DownloadFormat;
  }
  if (outputType === "presentation") return "pptx";
  if (outputType === "document") return "docx";
  return "md";
}

function responseHeaders(fileName: string, contentType: string) {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
  };
}

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: output, error } = await supabase
    .from("generated_outputs")
    .select("title,output_type,body_markdown,data")
    .eq("id", id)
    .maybeSingle();

  if (error || !output) {
    return NextResponse.json({ error: "Output not found." }, { status: 404 });
  }

  const format = requestedFormat(request, output.output_type);
  const baseName = safeFileName(output.title);

  if (format === "docx") {
    const buffer = await renderDocx({
      title: output.title,
      output_type: output.output_type,
      body_markdown: output.body_markdown,
      data: (output.data || {}) as Record<string, unknown>,
    });
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: responseHeaders(
        baseName + ".docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    });
  }

  if (format === "pptx") {
    const buffer = await renderPptx({
      title: output.title,
      output_type: output.output_type,
      body_markdown: output.body_markdown,
      data: (output.data || {}) as Record<string, unknown>,
    });
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: responseHeaders(
        baseName + ".pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    });
  }

  const body = output.body_markdown || JSON.stringify(output.data || {}, null, 2);
  return new Response(body, {
    status: 200,
    headers: responseHeaders(baseName + ".md", "text/markdown; charset=utf-8"),
  });
}
