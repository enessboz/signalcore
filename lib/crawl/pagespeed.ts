import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrawlFinding } from "@/lib/crawl/run-project-crawl";

type Strategy = "mobile" | "desktop";

type PsiResponse = {
  lighthouseResult?: {
    categories?: {
      performance?: { score?: number | null };
    };
    audits?: Record<
      string,
      {
        numericValue?: number | null;
        displayValue?: string | null;
      }
    >;
  };
  loadingExperience?: {
    metrics?: Record<string, { percentile?: number; category?: string }>;
    overall_category?: string;
  };
  originLoadingExperience?: {
    metrics?: Record<string, { percentile?: number; category?: string }>;
    overall_category?: string;
  };
  error?: { message?: string };
};

function auditValue(body: PsiResponse, key: string) {
  const value = body.lighthouseResult?.audits?.[key]?.numericValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function fetchPsi(url: string, strategy: Strategy) {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) throw new Error("PAGESPEED_API_KEY is not configured.");

  const endpoint = new URL(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
  );
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  endpoint.searchParams.set("category", "performance");
  endpoint.searchParams.set("key", apiKey);

  let response: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      response = await fetch(endpoint, {
        cache: "no-store",
        signal: controller.signal,
      });
      lastError = null;
    } catch (error) {
      lastError = error;
      response = null;
    } finally {
      clearTimeout(timer);
    }

    if (
      response &&
      ![429, 500, 502, 503, 504].includes(response.status)
    ) {
      break;
    }
    if (attempt < 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** attempt, 5000)),
      );
    }
  }

  if (!response) {
    throw lastError instanceof Error
      ? lastError
      : new Error("PageSpeed request failed.");
  }

  const body = (await response.json()) as PsiResponse;
  if (!response.ok) {
    throw new Error(
      body.error?.message ||
        "PageSpeed returned HTTP " + response.status + ".",
    );
  }

  const performanceScore =
    body.lighthouseResult?.categories?.performance?.score ?? null;
  const lcpMs = auditValue(body, "largest-contentful-paint");
  const cls = auditValue(body, "cumulative-layout-shift");
  const inpMs =
    auditValue(body, "interaction-to-next-paint") ??
    auditValue(body, "experimental-interaction-to-next-paint");
  const fcpMs = auditValue(body, "first-contentful-paint");
  const tbtMs = auditValue(body, "total-blocking-time");

  return {
    performanceScore,
    lcpMs,
    cls,
    inpMs,
    fcpMs,
    tbtMs,
    fieldData: body.loadingExperience || {},
    originFieldData: body.originLoadingExperience || {},
    rawCategory: body.lighthouseResult?.categories?.performance || {},
  };
}

function performanceFindings(input: {
  runId: string;
  url: string;
  strategy: Strategy;
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
}): CrawlFinding[] {
  const out: CrawlFinding[] = [];
  const key = encodeURIComponent(input.url).slice(0, 360);

  if (input.lcpMs !== null && input.lcpMs > 2500) {
    out.push({
      fingerprint: "crawl:cwv:lcp:" + input.strategy + ":" + key,
      title: "Largest Contentful Paint needs improvement",
      summary:
        input.url +
        " recorded approximately " +
        Math.round(input.lcpMs) +
        " ms LCP in the " +
        input.strategy +
        " PageSpeed lab run.",
      importance: input.lcpMs > 4000 ? "high" : "medium",
      affectedScope: {
        url: input.url,
        strategy: input.strategy,
        lcp_ms: input.lcpMs,
      },
      recommendedAction:
        "Review server response, render-blocking resources, the LCP resource and above-the-fold delivery. Confirm with field data before prioritizing broad template work.",
      metadata: {
        rule: "pagespeed_lcp",
        metric: "LCP",
        value_ms: input.lcpMs,
      },
    });
  }

  if (input.cls !== null && input.cls > 0.1) {
    out.push({
      fingerprint: "crawl:cwv:cls:" + input.strategy + ":" + key,
      title: "Cumulative Layout Shift needs improvement",
      summary:
        input.url +
        " recorded CLS " +
        input.cls.toFixed(3) +
        " in the " +
        input.strategy +
        " PageSpeed lab run.",
      importance: input.cls > 0.25 ? "high" : "medium",
      affectedScope: {
        url: input.url,
        strategy: input.strategy,
        cls: input.cls,
      },
      recommendedAction:
        "Identify shifting images, embeds, fonts and dynamically injected elements. Reserve stable layout space and validate changes against field CWV.",
      metadata: {
        rule: "pagespeed_cls",
        metric: "CLS",
        value: input.cls,
      },
    });
  }

  if (input.inpMs !== null && input.inpMs > 200) {
    out.push({
      fingerprint: "crawl:cwv:inp:" + input.strategy + ":" + key,
      title: "Interaction to Next Paint needs improvement",
      summary:
        input.url +
        " recorded approximately " +
        Math.round(input.inpMs) +
        " ms INP in available PageSpeed evidence.",
      importance: input.inpMs > 500 ? "high" : "medium",
      affectedScope: {
        url: input.url,
        strategy: input.strategy,
        inp_ms: input.inpMs,
      },
      recommendedAction:
        "Profile long main-thread tasks and interaction handlers. Reduce blocking JavaScript and validate improvements with real-user field data.",
      metadata: {
        rule: "pagespeed_inp",
        metric: "INP",
        value_ms: input.inpMs,
      },
    });
  }

  if (
    input.performanceScore !== null &&
    input.performanceScore < 0.5
  ) {
    out.push({
      fingerprint:
        "crawl:pagespeed-score:" + input.strategy + ":" + key,
      title: "Low PageSpeed performance score",
      summary:
        input.url +
        " scored " +
        Math.round(input.performanceScore * 100) +
        "/100 in the " +
        input.strategy +
        " PageSpeed performance category.",
      importance: "medium",
      affectedScope: {
        url: input.url,
        strategy: input.strategy,
        performance_score: input.performanceScore,
      },
      recommendedAction:
        "Use the metric-level diagnostics to identify the bottleneck rather than optimizing to the score itself.",
      metadata: {
        rule: "pagespeed_performance_score",
        performance_score: input.performanceScore,
      },
    });
  }

  return out;
}

export async function processPerformanceQueue(input: {
  client: SupabaseClient;
  batchSize?: number;
}) {
  const batchSize = Math.min(Math.max(Number(input.batchSize || 5), 1), 10);

  const { data: queue, error } = await input.client
    .from("crawl_performance_queue")
    .select("id,crawl_run_id,project_id,owner_id,url,strategy,status,attempts")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error("Performance queue could not be loaded: " + error.message);
  }

  const results: Array<Record<string, unknown>> = [];

  for (const item of queue || []) {
    const { data: claimed } = await input.client
      .from("crawl_performance_queue")
      .update({
        status: "running",
        attempts: Number(item.attempts || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();

    if (!claimed) continue;

    try {
      const psi = await fetchPsi(
        item.url,
        item.strategy === "desktop" ? "desktop" : "mobile",
      );

      const { error: resultError } = await input.client
        .from("crawl_performance_results")
        .upsert(
          {
            crawl_run_id: item.crawl_run_id,
            project_id: item.project_id,
            owner_id: item.owner_id,
            url: item.url,
            strategy: item.strategy,
            performance_score: psi.performanceScore,
            lcp_ms: psi.lcpMs,
            cls: psi.cls,
            inp_ms: psi.inpMs,
            fcp_ms: psi.fcpMs,
            tbt_ms: psi.tbtMs,
            field_data: {
              page: psi.fieldData,
              origin: psi.originFieldData,
            },
            lab_data: {
              lcp_ms: psi.lcpMs,
              cls: psi.cls,
              inp_ms: psi.inpMs,
              fcp_ms: psi.fcpMs,
              tbt_ms: psi.tbtMs,
            },
            raw_category: psi.rawCategory,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "crawl_run_id,url,strategy" },
        );

      if (resultError) {
        throw new Error(
          "Performance result could not be saved: " + resultError.message,
        );
      }

      const findings = performanceFindings({
        runId: item.crawl_run_id,
        url: item.url,
        strategy: item.strategy === "desktop" ? "desktop" : "mobile",
        performanceScore: psi.performanceScore,
        lcpMs: psi.lcpMs,
        cls: psi.cls,
        inpMs: psi.inpMs,
      });

      if (findings.length) {
        const now = new Date().toISOString();
        const { error: findingError } = await input.client
          .from("findings")
          .upsert(
            findings.map((finding) => ({
              project_id: item.project_id,
              owner_id: item.owner_id,
              finding_type: "issue",
              title: finding.title,
              summary: finding.summary,
              why_it_matters:
                "Performance evidence can affect user experience and search performance, but lab measurements should be validated against field data before broad remediation.",
              importance: finding.importance,
              confidence: "medium",
              status: "open",
              fingerprint: finding.fingerprint,
              affected_scope: finding.affectedScope,
              recommended_action: finding.recommendedAction,
              metadata: {
                source: "pagespeed",
                crawl_run_id: item.crawl_run_id,
                ...finding.metadata,
              },
              last_seen_at: now,
              updated_at: now,
            })),
            { onConflict: "project_id,fingerprint" },
          );
        if (findingError) {
          throw new Error(
            "Performance finding could not be saved: " +
              findingError.message,
          );
        }
      }

      await input.client
        .from("crawl_performance_queue")
        .update({
          status: "succeeded",
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      results.push({
        id: item.id,
        url: item.url,
        status: "succeeded",
        performance_score: psi.performanceScore,
        lcp_ms: psi.lcpMs,
        cls: psi.cls,
        inp_ms: psi.inpMs,
      });
    } catch (runError) {
      const attempts = Number(item.attempts || 0) + 1;
      const canRetry = attempts < 3;
      const message =
        runError instanceof Error ? runError.message : "PageSpeed failed.";

      await input.client
        .from("crawl_performance_queue")
        .update({
          status: canRetry ? "queued" : "failed",
          last_error: message,
          available_at: canRetry
            ? new Date(Date.now() + 15 * 60_000).toISOString()
            : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      results.push({
        id: item.id,
        url: item.url,
        status: canRetry ? "retry" : "failed",
        error: message,
      });
    }
  }

  return {
    selected: queue?.length || 0,
    processed: results.length,
    results,
  };
}
