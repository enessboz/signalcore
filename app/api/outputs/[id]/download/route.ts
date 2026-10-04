import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function safeFileName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "signalcore-output";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: output, error } = await supabase
    .from("generated_outputs")
    .select("title,body_markdown,data")
    .eq("id", id)
    .maybeSingle();

  if (error || !output) {
    return NextResponse.json({ error: "Output not found." }, { status: 404 });
  }

  const body = output.body_markdown || JSON.stringify(output.data || {}, null, 2);
  const fileName = safeFileName(output.title) + ".md";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
