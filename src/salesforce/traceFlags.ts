import type { Connection } from "@salesforce/core";
import {
  DEBUG_LEVEL_FIELDS,
  DEBUG_LEVEL_NAME,
  toTraceConfig,
  type TraceConfig,
} from "./debugLevels.js";
import { CLOCK_SKEW_MS, toDateTimeLiteral } from "./soql.js";

const TRACE_FLAG_SOBJECT = "TraceFlag";

// A Developer Console flag stores the user's logs too - see .claude/rules/trace-flags.md.
const STORING_LOG_TYPES = ["USER_DEBUG", "DEVELOPER_LOG"];

/** The entity's flags live now: whether one stores its logs, and the levels of each kind. */
export type ActiveTraceFlags = {
  storesLogs: boolean;
  /** Undefined when only a Developer Console flag, or none, is live. */
  userDebugLevels?: Required<TraceConfig>;
  /** The Developer Console flag's, which outrank every other; undefined when none is live. */
  developerConsoleLevels?: Required<TraceConfig>;
};

/**
 * The entity's live flags, with the levels of the debug level each points at,
 * in one query. At most one `USER_DEBUG` flag is live at a time, because
 * Salesforce refuses one whose window overlaps another.
 */
export async function findActiveTraceFlags(
  connection: Connection,
  tracedEntityId: string,
): Promise<ActiveTraceFlags> {
  const now = toDateTimeLiteral(new Date());
  const { records } = await connection.tooling.query<{
    LogType: string;
    DebugLevel: Record<string, unknown> | null;
  }>(
    `SELECT LogType, DebugLevel.DeveloperName, ${DEBUG_LEVEL_FIELDS.map((field) => `DebugLevel.${field}`).join(", ")}
     FROM ${TRACE_FLAG_SOBJECT}
     WHERE TracedEntityId = '${tracedEntityId}'
       AND (StartDate = null OR StartDate <= ${now}) AND ExpirationDate > ${now}
       AND LogType IN (${STORING_LOG_TYPES.map((type) => `'${type}'`).join(", ")})`,
  );
  // A run's own flag, still live or left by a failed delete, stores the log but is not the user's choice of levels.
  const userDebug = records.find(
    (flag) =>
      flag.LogType === "USER_DEBUG" &&
      flag.DebugLevel?.["DeveloperName"] !== DEBUG_LEVEL_NAME,
  );
  const developerConsole = records.find(
    (flag) => flag.LogType === "DEVELOPER_LOG",
  );
  return {
    storesLogs: records.length > 0,
    userDebugLevels: userDebug && toTraceConfig(userDebug.DebugLevel),
    developerConsoleLevels:
      developerConsole && toTraceConfig(developerConsole.DebugLevel),
  };
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
