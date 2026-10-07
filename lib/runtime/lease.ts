import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function acquireRuntimeLease(input: {
  client: SupabaseClient;
  key: string;
  ttlSeconds?: number;
}) {
  const holder = randomUUID();
  const { data, error } = await input.client.rpc("acquire_runtime_lease", {
    p_lease_key: input.key,
    p_holder: holder,
    p_ttl_seconds: input.ttlSeconds || 360,
  });

  if (error) {
    throw new Error("Runtime lease acquisition failed: " + error.message);
  }

  return {
    acquired: data === true,
    holder,
  };
}
