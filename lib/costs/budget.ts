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

async function syncBudgetFinding(input: {
  client: SupabaseClient;
  ownerId: string;
  projectId: string;
  category: CostCategory;
  state: BudgetState;
  projectedSpend?: number;
  blocked?: boolean;
}) {
  const fingerprint = "cost:budget:" + input.category;
  const limit = input.state.monthlyLimit;
  const spend =
    input.projectedSpend === undefined
      ? input.state.currentSpend
      : input.projectedSpend;
  const percent =
    limit !== null && limit > 0 ? (spend / limit) * 100 : 0;
  const warningThreshold = Number(input.state.softWarningPercent || 80);
  const shouldWarn =
    limit !== null &&
    limit > 0 &&
    (Boolean(input.blocked) || percent >= warningThreshold);

  if (!shouldWarn) {
    const { error } = await input.client
      .from("findings")
      .update({
        status: "resolved",
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", input.projectId)
      .eq("owner_id", input.ownerId)
      .eq("fingerprint", fingerprint)
      .in("status", ["open", "monitoring"]);

    if (error) {
      throw new Error("Budget finding resolution failed: " + error.message);
    }
    return;
  }

  const now = new Date().toISOString();
  const blocked = Boolean(input.blocked);
  const { error } = await input.client.from("findings").upsert(
    {
      project_id: input.projectId,
      owner_id: input.ownerId,
      finding_type: "observation",
      title: blocked
        ? input.category.toUpperCase() + " monthly budget hard-stop reached"
        : input.category.toUpperCase() + " monthly budget warning",
      summary:
        "Recorded/projected " +
        input.category +
        " spend is $" +
        spend.toFixed(4) +
        " of the $" +
        Number(limit).toFixed(2) +
        " monthly limit (" +
        percent.toFixed(1) +
        "%).",
      why_it_matters:
        "SignalCore uses deterministic budget guardrails so paid providers cannot consume unbounded project budget.",
      importance: blocked ? "high" : "medium",
      confidence: "high",
      status: "open",
      fingerprint,
      affected_scope: {
        category: input.category,
        monthly_limit: limit,
        spend,
        percent,
      },
      recommended_action: blocked
        ? "Review current-month usage before increasing the budget or resuming paid calls."
        : "Review the remaining monthly budget and expected scheduled work before the hard stop is reached.",
      metadata: {
        source: "budget_guard",
        category: input.category,
        monthly_limit: limit,
        current_spend: input.state.currentSpend,
        projected_spend: spend,
        soft_warning_percent: warningThreshold,
        hard_stop: input.state.hardStop,
        blocked,
      },
      last_seen_at: now,
      updated_at: now,
    },
    { onConflict: "project_id,fingerprint" },
  );

  if (error) {
    throw new Error("Budget finding upsert failed: " + error.message);
  }
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
