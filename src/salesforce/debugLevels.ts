import { Connection } from "@salesforce/core";

const DEBUG_LEVEL_SOBJECT = "DebugLevel";
const DEBUG_LEVEL_NAME = "Apex_Log_MCP_Debug_Level";

/** `as const` so that `z.enum` can consume it — this is the only list of levels. */
export const LOG_LEVELS = [
  "NONE",
  "ERROR",
  "WARN",
  "INFO",
  "DEBUG",
  "FINE",
  "FINER",
  "FINEST",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The DebugLevel field names, lower-camel. `toSObjectFields` capitalises them. */
export const TRACE_CATEGORIES = [
  "apexCode",
  "apexProfiling",
  "callout",
  "database",
  "nba",
  "system",
  "validation",
  "visualforce",
  "wave",
  "workflow",
] as const;

export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

export type TraceConfig = Partial<Record<TraceCategory, LogLevel>>;

/**
 * The same categories as a debug log header spells them.
 *
 * A log opens with `APEX_CODE,FINE;DB,FINEST;…`, which is what the parser reads
 * into `debugLevels`, so this is the spelling every response uses. `DATA_ACCESS`
 * appears there but is not a `DebugLevel` field, so nothing can set it.
 */
export const LOG_CATEGORIES = [
  "APEX_CODE",
  "APEX_PROFILING",
  "CALLOUT",
  "DATA_ACCESS",
  "DB",
  "NBA",
  "SYSTEM",
  "VALIDATION",
  "VISUALFORCE",
  "WAVE",
  "WORKFLOW",
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

/**
 * A settable category under the name a debug log header gives it.
 *
 * `DATA_ACCESS` is absent because no `DebugLevel` field sets it, so nothing
 * here can ask for it and nothing should expect it back.
 */
export const CATEGORY_LOG_NAMES: Record<TraceCategory, LogCategory> = {
  apexCode: "APEX_CODE",
  apexProfiling: "APEX_PROFILING",
  callout: "CALLOUT",
  database: "DB",
  nba: "NBA",
  system: "SYSTEM",
  validation: "VALIDATION",
  visualforce: "VISUALFORCE",
  wave: "WAVE",
  workflow: "WORKFLOW",
};

/** The only place the per-category defaults live. */
export const DEFAULT_TRACE_CONFIG: Required<TraceConfig> = {
  apexCode: "FINE",
  apexProfiling: "FINE",
  callout: "DEBUG",
  database: "FINEST",
  nba: "INFO",
  system: "DEBUG",
  validation: "DEBUG",
  visualforce: "FINE",
  wave: "INFO",
  workflow: "FINE",
};

export type DebugLevelInput = "default" | LogLevel | TraceConfig;

function isLogLevel(value: DebugLevelInput): value is LogLevel {
  return (
    typeof value === "string" &&
    (LOG_LEVELS as readonly string[]).includes(value)
  );
}

function resolveLevels(debugLevel: DebugLevelInput): Record<string, string> {
  if (debugLevel === "default") return resolveAllDefaults();
  if (isLogLevel(debugLevel)) return allCategoriesAt(debugLevel);
  return toSObjectFields(debugLevel);
}

function allCategoriesAt(level: LogLevel) {
  return toSObjectFields(
    Object.fromEntries(TRACE_CATEGORIES.map((category) => [category, level])),
  );
}

type DebugLevelRecord = {
  Id: string;
} & Record<string, unknown>;

/** A DebugLevel record and the levels it carries after this call. */
export type EnsuredDebugLevel = {
  id: string;
  levels: Required<TraceConfig>;
};

/** Every DebugLevel field name is the category with its first letter capitalised. */
function toFieldName(category: TraceCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function toSObjectFields(config: TraceConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, level]) => level !== undefined)
      .map(([category, level]) => [
        category.charAt(0).toUpperCase() + category.slice(1),
        level,
      ]),
  );
}

function toTraceConfig(fields: Record<string, unknown>): Required<TraceConfig> {
  return Object.fromEntries(
    TRACE_CATEGORIES.map((category) => [
      category,
      fields[toFieldName(category)] ?? DEFAULT_TRACE_CONFIG[category],
    ]),
  ) as Required<TraceConfig>;
}

function resolveAllDefaults() {
  return toSObjectFields(DEFAULT_TRACE_CONFIG);
}

/**
 * Find or create the server's DebugLevel and report the levels it now carries.
 *
 * A partial `debugLevel` leaves the categories it does not name as the record
 * has them, so only the record itself knows the levels the org will apply.
 */
export async function ensureDebugLevel(
  connection: Connection,
  debugLevel?: DebugLevelInput,
): Promise<EnsuredDebugLevel> {
  const existing = await findDebugLevel(connection);

  if (existing) {
    const applied = debugLevel === undefined ? {} : resolveLevels(debugLevel);
    if (debugLevel !== undefined) {
      await updateDebugLevel(connection, existing.Id, applied);
    }
    return {
      id: existing.Id,
      levels: toTraceConfig({ ...existing, ...applied }),
    };
  }

  const levels =
    debugLevel === undefined || debugLevel === "default"
      ? resolveAllDefaults()
      : isLogLevel(debugLevel)
        ? allCategoriesAt(debugLevel)
        : { ...resolveAllDefaults(), ...toSObjectFields(debugLevel) };
  return {
    id: await createDebugLevel(connection, levels),
    levels: toTraceConfig(levels),
  };
}

async function findDebugLevel(
  connection: Connection,
): Promise<DebugLevelRecord | null> {
  const result = await connection.tooling.query(
    `SELECT Id, ${TRACE_CATEGORIES.map(toFieldName).join(", ")}
     FROM ${DEBUG_LEVEL_SOBJECT}
     WHERE DeveloperName = '${DEBUG_LEVEL_NAME}'
     LIMIT 1`,
  );

  if (result.records.length === 0) {
    return null;
  }

  const record = result.records[0] as DebugLevelRecord;
  if (!record.Id) {
    return null;
  }

  return record;
}

async function updateDebugLevel(
  connection: Connection,
  id: string,
  levels: Record<string, string>,
): Promise<void> {
  const result = await connection.tooling
    .sobject(DEBUG_LEVEL_SOBJECT)
    .update({ Id: id, ...levels });

  if (!result.success) {
    throw new Error(
      `Failed to update DebugLevel: ${JSON.stringify(result.errors)}`,
    );
  }
}

async function createDebugLevel(
  connection: Connection,
  levels: Record<string, string>,
): Promise<string> {
  const result = await connection.tooling.sobject(DEBUG_LEVEL_SOBJECT).create({
    DeveloperName: DEBUG_LEVEL_NAME,
    MasterLabel: DEBUG_LEVEL_NAME,
    ...levels,
  });

  if (!result.success || !result.id) {
    throw new Error("Failed to create DebugLevel");
  }

  return result.id;
}
