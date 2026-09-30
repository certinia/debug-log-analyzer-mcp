import type { Connection } from "@salesforce/core";
import { CLOCK_SKEW_MS } from "./soql.js";

const TRACE_FLAG_SOBJECT = "TraceFlag";

/**
 * Create a `USER_DEBUG` flag live for `durationMs`, and return its id.
 *
 * Starts back by the clock skew, so an org clock behind this one still sees it
 * live. Throws when the entity already has an overlapping flag of this type -
 * see `isAlreadyTraced`.
 */
export async function createTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string,
  durationMs: number,
): Promise<string> {
  const now = Date.now();
  const result = await connection.tooling.sobject(TRACE_FLAG_SOBJECT).create({
    TracedEntityId: tracedEntityId,
    DebugLevelId: debugLevelId,
    StartDate: new Date(now - CLOCK_SKEW_MS).toISOString(),
    ExpirationDate: new Date(now + durationMs).toISOString(),
    LogType: "USER_DEBUG",
  });

  if (!result.success || !result.id) {
    throw new Error(
      `Failed to create TraceFlag: ${JSON.stringify(result.errors)}`,
    );
  }

  return result.id;
}

/** Whether a create failed because the entity already has a flag in that window. */
export function isAlreadyTraced(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { errorCode?: string }).errorCode === "FIELD_INTEGRITY_EXCEPTION" &&
    error.message.includes("already being traced")
  );
}

export async function deleteTraceFlag(
  connection: Connection,
  traceFlagId: string,
): Promise<void> {
  const result = await connection.tooling
    .sobject(TRACE_FLAG_SOBJECT)
    .destroy(traceFlagId);

  if (!result.success) {
    throw new Error(
      `Failed to delete TraceFlag: ${JSON.stringify(result.errors)}`,
    );
  }
}
