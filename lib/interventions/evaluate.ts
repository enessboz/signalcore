import type { SupabaseClient } from "@supabase/supabase-js";

type MetricBlock = Record<string, unknown>;

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pctChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 1 : 0;
  return (current - previous) / previous;
}

function metricPair(
  payload: Record<string, unknown>,
  source: "gsc_query" | "gsc_page" | "ga4",
) {
  const block = (payload[source] || {}) as Record<string, unknown>;
  return {
    baseline: (block.baseline || {}) as MetricBlock,
    post: (block.post || {}) as MetricBlock,
  };
}

function coverageValue(
  payload: Record<string, unknown>,
  key: string,
) {
  const coverage = (payload.coverage || {}) as Record<string, unknown>;
  return num(coverage[key]);
}

function summarizeMovement(payload: Record<string, unknown>) {
  const query = metricPair(payload, "gsc_query");
  const page = metricPair(payload, "gsc_page");
  const ga4 = metricPair(payload, "ga4");

  let score = 0;
  let positiveSignals = 0;
  let negativeSignals = 0;
  const signals: Array<Record<string, unknown>> = [];

  function addSignal(
    name: string,
    change: number,
    weight: number,
    threshold: number,
  ) {
    if (change >= threshold) {
      score += weight;
      positiveSignals += 1;
      signals.push({ name, direction: "up", change });
    } else if (change <= -threshold) {
      score -= weight;
      negativeSignals += 1;
      signals.push({ name, direction: "down", change });
    }
  }

  const queryClicksBefore = num(query.baseline.clicks);
  const queryClicksAfter = num(query.post.clicks);
  const queryImpressionsBefore = num(query.baseline.impressions);
  const queryImpressionsAfter = num(query.post.impressions);
  const queryPositionBefore = num(query.baseline.position);
  const queryPositionAfter = num(query.post.position);

  if (queryClicksBefore > 0 || queryClicksAfter > 0) {
    addSignal(
      "GSC query clicks",
      pctChange(queryClicksAfter, queryClicksBefore),
      2,
      0.15,
    );
  }
  if (queryImpressionsBefore > 0 || queryImpressionsAfter > 0) {
    addSignal(
      "GSC query impressions",
      pctChange(queryImpressionsAfter, queryImpressionsBefore),
      1,
      0.2,
    );
  }
  if (queryPositionBefore > 0 && queryPositionAfter > 0) {
    const improvement = queryPositionBefore - queryPositionAfter;
    if (improvement >= 1) {
      score += 1;
      positiveSignals += 1;
      signals.push({
        name: "GSC query position",
        direction: "improved",
        change: improvement,
      });
    } else if (improvement <= -1) {
      score -= 1;
      negativeSignals += 1;
      signals.push({
        name: "GSC query position",
        direction: "declined",
        change: improvement,
      });
    }
  }

  const pageClicksBefore = num(page.baseline.clicks);
  const pageClicksAfter = num(page.post.clicks);
  if (pageClicksBefore > 0 || pageClicksAfter > 0) {
    addSignal(
      "GSC page clicks",
      pctChange(pageClicksAfter, pageClicksBefore),
      2,
      0.15,
    );
  }

  const sessionsBefore = num(ga4.baseline.sessions);
  const sessionsAfter = num(ga4.post.sessions);
  if (sessionsBefore > 0 || sessionsAfter > 0) {
    addSignal(
      "GA4 organic sessions",
      pctChange(sessionsAfter, sessionsBefore),
      2,
      0.15,
    );
  }

  const keyEventsBefore = num(ga4.baseline.key_events);
  const keyEventsAfter = num(ga4.post.key_events);
  if (keyEventsBefore >= 5 || keyEventsAfter >= 5) {
    addSignal(
      "GA4 key events",
      pctChange(keyEventsAfter, keyEventsBefore),
      1,
      0.2,
    );
  }

  let resultClass:
    | "improved"
    | "declined"
    | "mixed"
    | "no_change" = "no_change";

  if (positiveSignals > 0 && negativeSignals > 0) {
    resultClass = "mixed";
  } else if (score >= 2) {
    resultClass = "improved";
  } else if (score <= -2) {
    resultClass = "declined";
  }

  return {
    resultClass,
    score,
    positiveSignals,
    negativeSignals,
    signals,
    query,
    page,
    ga4,
  };
}

export async function evaluateInterventionCheck(input: {
  checkId: string;
  client: SupabaseClient;
}) {
  const supabase = input.client;
  const { data: check, error: checkError } = await supabase
    .from("seo_intervention_checks")
    .select(
      "id,intervention_id,project_id,owner_id,checkpoint_days,due_date,status",
    )
    .eq("id", input.checkId)
    .single();

  if (checkError || !check) {
    throw new Error(
      "Intervention checkpoint not found: " +
        (checkError?.message || input.checkId),
    );
  }

  const { data: intervention, error: interventionError } = await supabase
    .from("seo_interventions")
    .select(
      "id,title,intervention_type,implemented_at,status,scope_mode,hypothesis",
    )
    .eq("id", check.intervention_id)
    .eq("project_id", check.project_id)
    .eq("owner_id", check.owner_id)
    .single();

  if (interventionError || !intervention) {
    throw new Error(
      "SEO intervention not found: " +
        (interventionError?.message || check.intervention_id),
    );
  }

  if (intervention.status === "cancelled") {
    await supabase
      .from("seo_intervention_checks")
      .update({
        status: "skipped",
        summary: "Intervention was cancelled before this checkpoint.",
        evaluated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", check.id);

    return { status: "skipped", checkId: check.id };
  }

  const { data: metricData, error: metricError } = await supabase.rpc(
    "get_seo_intervention_metrics",
    {
      p_intervention_id: check.intervention_id,
      p_checkpoint_days: check.checkpoint_days,
    },
  );

  if (metricError) {
    throw new Error(
      "Intervention metric evaluation failed: " + metricError.message,
    );
  }

  const metrics = (metricData || {}) as Record<string, unknown>;
  const requiredDays = Math.max(
    5,
    Math.ceil(Number(check.checkpoint_days) * 0.7),
  );

  const gscBaselineDays = Math.max(
    coverageValue(metrics, "gsc_query_baseline_days"),
    coverageValue(metrics, "gsc_page_baseline_days"),
  );
  const gscPostDays = Math.max(
    coverageValue(metrics, "gsc_query_post_days"),
    coverageValue(metrics, "gsc_page_post_days"),
  );
  const ga4BaselineDays = coverageValue(metrics, "ga4_baseline_days");
  const ga4PostDays = coverageValue(metrics, "ga4_post_days");

  const gscReady =
    gscBaselineDays >= requiredDays && gscPostDays >= requiredDays;
  const ga4Ready =
    ga4BaselineDays >= requiredDays && ga4PostDays >= requiredDays;

  const now = new Date().toISOString();

  if (!gscReady && !ga4Ready) {
    const summary =
      "Checkpoint is due, but warehouse coverage is not sufficient yet. " +
      "Required " +
      requiredDays +
      " baseline/post days; GSC has " +
      gscBaselineDays +
      "/" +
      gscPostDays +
      " and GA4 has " +
      ga4BaselineDays +
      "/" +
      ga4PostDays +
      ".";

    await supabase
      .from("seo_intervention_checks")
      .update({
        result_class: "insufficient_data",
        metrics,
        summary,
        last_attempt_at: now,
        last_error: null,
        updated_at: now,
      })
      .eq("id", check.id);

    return {
      status: "pending",
      checkId: check.id,
      resultClass: "insufficient_data",
      requiredDays,
      gscReady,
      ga4Ready,
    };
  }

  const movement = summarizeMovement(metrics);
  const resultLabel = movement.resultClass.replace("_", " ");
  const summary =
    "At D+" +
    check.checkpoint_days +
    ", the available first-party data shows a " +
    resultLabel +
    " post-intervention pattern. This is an observed association, not proof that the intervention caused the movement.";

  const fingerprint =
    "intervention:" +
    check.intervention_id +
    ":d" +
    String(check.checkpoint_days);

  const { data: existingFinding } = await supabase
    .from("findings")
    .select("status")
    .eq("project_id", check.project_id)
    .eq("owner_id", check.owner_id)
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  const importance =
    movement.resultClass === "declined"
      ? "high"
      : movement.resultClass === "improved"
        ? "medium"
        : "low";

  const { error: findingError } = await supabase.from("findings").upsert(
    {
      project_id: check.project_id,
      owner_id: check.owner_id,
      finding_type: "observation",
      title:
        "D+" +
        check.checkpoint_days +
        " intervention observation: " +
        intervention.title,
      summary,
      why_it_matters:
        "Tracking interventions against first-party warehouse data helps separate remembered changes from measured post-change movement while avoiding unsupported causal claims.",
      importance,
      confidence: gscReady && ga4Ready ? "high" : "medium",
      status: existingFinding?.status || "open",
      fingerprint,
      affected_scope: {
        intervention_id: intervention.id,
        checkpoint_days: check.checkpoint_days,
        scope_mode: intervention.scope_mode,
      },
      recommended_action:
        movement.resultClass === "declined"
          ? "Review the affected URLs and queries, confirm whether the movement persists, and check for unrelated technical, SERP or seasonality changes before reverting anything."
          : movement.resultClass === "improved"
            ? "Continue monitoring through the next checkpoint before generalizing the change to other pages."
            : "Keep monitoring through the next checkpoint and avoid drawing a causal conclusion from the current mixed or limited movement.",
      metadata: {
        detector: "seo_intervention_monitor_v1",
        source: "intervention_monitor",
        rule: "post_intervention_observation",
        intervention_type: intervention.intervention_type,
        implemented_at: intervention.implemented_at,
        result_class: movement.resultClass,
        score: movement.score,
        signals: movement.signals,
        metrics,
      },
      last_seen_at: now,
      updated_at: now,
    },
    { onConflict: "project_id,fingerprint" },
  );

  if (findingError) {
    throw new Error(
      "Intervention observation could not be saved: " +
        findingError.message,
    );
  }

  const { error: updateError } = await supabase
    .from("seo_intervention_checks")
    .update({
      status: "evaluated",
      result_class: movement.resultClass,
      metrics,
      summary,
      evaluated_at: now,
      last_attempt_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq("id", check.id);

  if (updateError) {
    throw new Error(
      "Intervention checkpoint could not be updated: " +
        updateError.message,
    );
  }

  if (Number(check.checkpoint_days) >= 28) {
    await supabase
      .from("seo_interventions")
      .update({
        status: "completed",
        updated_at: now,
      })
      .eq("id", intervention.id)
      .eq("status", "monitoring");
  }

  return {
    status: "evaluated",
    checkId: check.id,
    interventionId: intervention.id,
    checkpointDays: check.checkpoint_days,
    resultClass: movement.resultClass,
    score: movement.score,
    gscReady,
    ga4Ready,
  };
}
