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
};

/** Every DebugLevel field name is the category with its first letter capitalised. */
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

function resolveAllDefaults() {
  return toSObjectFields(DEFAULT_TRACE_CONFIG);
}

export async function getOrCreateDebugLevelId(
  connection: Connection,
  debugLevel?: DebugLevelInput,
): Promise<string> {
  const existing = await findDebugLevel(connection);

  if (existing) {
    if (debugLevel !== undefined) {
      const levels = resolveLevels(debugLevel);
      await updateDebugLevel(connection, existing.Id, levels);
    }
    return existing.Id;
  }

  const levels =
    debugLevel === undefined || debugLevel === "default"
      ? resolveAllDefaults()
      : isLogLevel(debugLevel)
        ? allCategoriesAt(debugLevel)
        : { ...resolveAllDefaults(), ...toSObjectFields(debugLevel) };
  return await createDebugLevel(connection, levels);
}

async function findDebugLevel(
  connection: Connection,
): Promise<DebugLevelRecord | null> {
  const result = await connection.tooling.query(
    `SELECT Id
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
