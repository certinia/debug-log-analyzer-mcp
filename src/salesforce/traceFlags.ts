import type { Connection } from "@salesforce/core";
import { CLOCK_SKEW_MS, toDateTimeLiteral } from "./soql.js";

const TRACE_FLAG_SOBJECT = "TraceFlag";

// A Developer Console flag stores the user's logs too - see .claude/rules/trace-flags.md.
const STORING_LOG_TYPES = ["USER_DEBUG", "DEVELOPER_LOG"];

/** Whether the entity has a flag live now that stores its logs. */
export async function hasActiveTraceFlag(
  connection: Connection,
  tracedEntityId: string,
): Promise<boolean> {
  const now = toDateTimeLiteral(new Date());
  const flag = await connection.tooling.sobject(TRACE_FLAG_SOBJECT).findOne(
    {
      TracedEntityId: tracedEntityId,
      StartDate: { $lte: now },
      ExpirationDate: { $gt: now },
      LogType: { $in: STORING_LOG_TYPES },
    },
    ["Id"],
  );
  return flag !== null;
}

/**
 * Create a `USER_DEBUG` flag live for `durationMs`, and return its id.
 *
 * Starts back by the clock skew, so an org clock behind this one still sees it
 * live. Salesforce refuses it when the entity has a `USER_DEBUG` flag whose
 * window overlaps, live or not.
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

/** Delete a trace flag by id. */
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
