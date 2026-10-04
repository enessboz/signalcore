import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString();
}

export async function getBudgetState(input: {
  ownerId: string;
  projectId: string;
  category: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const [{ data: limit }, { data: usage }] = await Promise.all([
    supabase
      .from("budget_limits")
      .select("monthly_limit,soft_warning_percent,hard_stop")
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .eq("category", input.category)
      .maybeSingle(),
    supabase
      .from("usage_events")
      .select("estimated_cost,actual_cost")
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .eq("category", input.category)
      .gte("created_at", monthStartIso()),
  ]);

  const spent = (usage || []).reduce(
    (sum, item) =>
      sum + Number(item.actual_cost ?? item.estimated_cost ?? 0),
    0,
  );

  const monthlyLimit =
    limit?.monthly_limit !== null && limit?.monthly_limit !== undefined
      ? Number(limit.monthly_limit)
      : null;

  const percent =
    monthlyLimit && monthlyLimit > 0 ? (spent / monthlyLimit) * 100 : 0;

  return {
    configured: Boolean(limit),
    monthlyLimit,
    spent,
    remaining:
      monthlyLimit === null ? null : Math.max(monthlyLimit - spent, 0),
    percent,
    softWarningPercent: Number(limit?.soft_warning_percent || 80),
    hardStop: Boolean(limit?.hard_stop),
  };
}

export async function assertBudgetAvailable(input: {
  ownerId: string;
  projectId: string;
  category: string;
  estimatedNextCost?: number;
  client?: SupabaseClient;
}) {
  const state = await getBudgetState(input);

  if (
    state.configured &&
    state.hardStop &&
    state.monthlyLimit !== null &&
    state.spent + Number(input.estimatedNextCost || 0) >= state.monthlyLimit
  ) {
    throw new Error(
      `${input.category.toUpperCase()} monthly budget hard-stop reached for this project. Used $${state.spent.toFixed(2)} of $${state.monthlyLimit.toFixed(2)}.`,
    );
  }

  return state;
}

export async function logUsage(input: {
  ownerId: string;
  projectId: string;
  category: string;
  provider?: string | null;
  units?: number | null;
  estimatedCost?: number | null;
  actualCost?: number | null;
  metadata?: Record<string, unknown>;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { error } = await supabase.from("usage_events").insert({
    project_id: input.projectId,
    owner_id: input.ownerId,
    category: input.category,
    provider: input.provider || null,
    units: input.units ?? null,
    estimated_cost: input.estimatedCost ?? null,
    actual_cost: input.actualCost ?? null,
    metadata: input.metadata || {},
  });

  if (error) {
    throw new Error(`Usage event could not be logged: ${error.message}`);
  }
}
