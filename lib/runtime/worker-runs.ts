import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type RuntimeWorkerStatus =
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "skipped";

export type RuntimeRunTracker = {
  batchId: string;
  ownerIds: string[];
  workerKey: string;
  startedAt: number;
};

function uniqueOwners(ownerIds: Array<string | null | undefined>) {
  return Array.from(
    new Set(ownerIds.map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

export async function startRuntimeWorkerRun(input: {
  client: SupabaseClient;
  workerKey: string;
  ownerIds: Array<string | null | undefined>;
  triggerType?: "cron" | "manual" | "system";
  metadata?: Record<string, unknown>;
}): Promise<RuntimeRunTracker> {
  const ownerIds = uniqueOwners(input.ownerIds);
  const tracker: RuntimeRunTracker = {
    batchId: randomUUID(),
    ownerIds,
    workerKey: input.workerKey,
    startedAt: Date.now(),
  };

  if (!ownerIds.length) return tracker;

  const { error } = await input.client.from("runtime_worker_runs").insert(
    ownerIds.map((ownerId) => ({
      batch_id: tracker.batchId,
      owner_id: ownerId,
      worker_key: input.workerKey,
      trigger_type: input.triggerType || "cron",
      status: "running",
      metadata: input.metadata || {},
      started_at: new Date(tracker.startedAt).toISOString(),
    })),
  );

  if (error) {
    throw new Error("Runtime worker run could not be started: " + error.message);
  }

  return tracker;
}

export async function finishRuntimeWorkerRun(input: {
  client: SupabaseClient;
  tracker: RuntimeRunTracker;
  status: Exclude<RuntimeWorkerStatus, "running">;
  metrics?: Record<string, unknown>;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!input.tracker.ownerIds.length) return;

  const completedAt = new Date();
  const { error } = await input.client
    .from("runtime_worker_runs")
    .update({
      status: input.status,
      metrics: input.metrics || {},
      metadata: input.metadata || {},
      error: input.error || null,
      completed_at: completedAt.toISOString(),
      duration_ms: Math.max(completedAt.getTime() - input.tracker.startedAt, 0),
    })
    .eq("batch_id", input.tracker.batchId)
    .eq("worker_key", input.tracker.workerKey)
    .in("owner_id", input.tracker.ownerIds);

  if (error) {
    throw new Error("Runtime worker run could not be finished: " + error.message);
  }
}

export function summarizeWorkerStatus(input: {
  processed: number;
  failed?: number;
  partial?: number;
}) {
  const processed = Number(input.processed || 0);
  const failed = Number(input.failed || 0);
  const partial = Number(input.partial || 0);

  if (failed > 0 && failed >= processed && partial === 0) return "failed" as const;
  if (failed > 0 || partial > 0) return "partial" as const;
  return "succeeded" as const;
}
