"use server";

import { redirect } from "next/navigation";
import { runProjectCrawl } from "@/lib/crawl/run-project-crawl";
import { createClient } from "@/lib/supabase/server";

export async function runTechnicalCrawl(projectId: string, formData: FormData) {
  const raw = Number(String(formData.get("maxUrls") || "100"));
  const maxUrls = [25, 50, 100, 200, 500].includes(raw) ? raw : 100;

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const ownerId = claimsData?.claims?.sub;
  if (!ownerId) redirect("/login");

  try {
    const result = await runProjectCrawl({
      ownerId,
      projectId,
      maxUrls,
      crawlType: "http",
    });

    redirect(
      `/projects/${projectId}/technical?run=${result.runId}&message=${encodeURIComponent(
        `Crawl completed: ${String(result.summary.pages_crawled || 0)} pages`,
      )}`,
    );
  } catch (error) {
    redirect(
      `/projects/${projectId}/technical?error=${encodeURIComponent(
        error instanceof Error ? error.message : "Technical crawl failed",
      )}`,
    );
  }
}
