import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchGoogleOrganicSerp } from "@/lib/seo/dataforseo";
import { createClient } from "@/lib/supabase/server";

export async function runSerpResearch(input: {
  ownerId: string;
  projectId: string;
  keywords: string[];
  locationCode?: number;
  languageCode?: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());
  const keywords = Array.from(
    new Set(input.keywords.map((keyword) => keyword.trim()).filter(Boolean)),
  ).slice(0, 10);

  if (!keywords.length) throw new Error("At least one SERP keyword is required.");

  const results: Array<{
    keyword: string;
    success: boolean;
    cost: number;
    error?: string;
  }> = [];

  for (const keyword of keywords) {
    try {
      const result = await fetchGoogleOrganicSerp({
        keyword,
        locationCode: input.locationCode || 2840,
        languageCode: input.languageCode || "en",
        depth: 30,
      });

      const { error } = await supabase.from("serp_checks").insert({
        project_id: input.projectId,
        owner_id: input.ownerId,
        provider: "dataforseo",
        engine: "google",
        search_type: "organic",
        keyword,
        location_code: input.locationCode || 2840,
        language_code: input.languageCode || "en",
        status: "succeeded",
        result: {
          check_url: result.check_url,
          organic: result.organic,
          serp_features: result.serp_features,
        },
        estimated_cost: result.cost,
      });
      if (error) throw error;

      results.push({
        keyword,
        success: true,
        cost: result.cost,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "SERP request failed.";
      await supabase.from("serp_checks").insert({
        project_id: input.projectId,
        owner_id: input.ownerId,
        provider: "dataforseo",
        engine: "google",
        search_type: "organic",
        keyword,
        location_code: input.locationCode || 2840,
        language_code: input.languageCode || "en",
        status: "failed",
        result: { error: message },
      });

      results.push({
        keyword,
        success: false,
        cost: 0,
        error: message,
      });
    }
  }

  return {
    requested: keywords.length,
    succeeded: results.filter((item) => item.success).length,
    failed: results.filter((item) => !item.success).length,
    estimatedCost: results.reduce((sum, item) => sum + item.cost, 0),
    results,
  };
}
