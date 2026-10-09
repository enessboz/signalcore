import { NextRequest, NextResponse } from "next/server";
import { fetchGoogleOrganicSerp } from "@/lib/seo/dataforseo";

export const maxDuration = 60;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === "Bearer " + secret;
}

async function testOpenAi() {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_ROUTINE_MODEL || "gpt-6-luna";

  if (!key) {
    return {
      configured: false,
      ok: false,
      model,
      error: "OPENAI_API_KEY is not configured.",
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: "Return exactly OK.",
      max_output_tokens: 16,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; type?: string; code?: string | null };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };

  return {
    configured: true,
    ok: response.ok,
    model,
    status: response.status,
    response_id: payload.id || null,
    usage: payload.usage || null,
    error: response.ok
      ? null
      : payload.error?.message || "OpenAI live test failed.",
    error_type: payload.error?.type || null,
    error_code: payload.error?.code || null,
  };
}

async function testDataForSeo() {
  const configured = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );

  if (!configured) {
    return {
      configured: false,
      ok: false,
      error: "DataForSEO credentials are not configured.",
    };
  }

  try {
    const result = await fetchGoogleOrganicSerp({
      keyword: "calorie deficit",
      locationCode: 2840,
      languageCode: "en",
      device: "desktop",
      depth: 10,
    });

    return {
      configured: true,
      ok: true,
      keyword: result.keyword,
      organic_results: result.organic.length,
      cost: result.cost,
      check_url_present: Boolean(result.check_url),
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error:
        error instanceof Error ? error.message : "DataForSEO live test failed.",
    };
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const live = request.nextUrl.searchParams.get("live") === "1";

  const presence = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    openai_routine_model: process.env.OPENAI_ROUTINE_MODEL || null,
    openai_reasoning_model: process.env.OPENAI_REASONING_MODEL || null,
    openai_coding_model: process.env.OPENAI_CODING_MODEL || null,
    dataforseo: Boolean(
      process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
    ),
    serp_estimated_cost_configured: Boolean(
      process.env.SERP_ESTIMATED_COST_PER_REQUEST_USD,
    ),
  };

  if (!live) {
    return NextResponse.json({
      status: "ok",
      presence,
      secret_values_exposed: false,
    });
  }

  const [openai, dataforseo] = await Promise.all([
    testOpenAi(),
    testDataForSeo(),
  ]);

  return NextResponse.json({
    status: openai.ok && dataforseo.ok ? "healthy" : "degraded",
    presence,
    live_tests: {
      openai,
      dataforseo,
    },
    secret_values_exposed: false,
    tested_at: new Date().toISOString(),
  });
}
