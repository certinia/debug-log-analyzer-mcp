import { Connection } from "@salesforce/core";

const DEBUG_LEVEL_SOBJECT = "DebugLevel";
const MCP_DEBUG_LEVEL_NAME = "LANA_MCP_Debug_Level";

export type LogLevel =
  | "NONE"
  | "ERROR"
  | "WARN"
  | "INFO"
  | "DEBUG"
  | "FINE"
  | "FINER"
  | "FINEST";

export type TraceConfig = {
  apexCode?: LogLevel;
  apexProfiling?: LogLevel;
  callout?: LogLevel;
  database?: LogLevel;
  nba?: LogLevel;
  system?: LogLevel;
  validation?: LogLevel;
  visualforce?: LogLevel;
  wave?: LogLevel;
  workflow?: LogLevel;
};

const DEFAULT_TRACE_CONFIG: Required<TraceConfig> = {
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

const LOG_LEVELS: readonly string[] = [
  "NONE",
  "ERROR",
  "WARN",
  "INFO",
  "DEBUG",
  "FINE",
  "FINER",
  "FINEST",
];

function isLogLevel(value: DebugLevelInput): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.includes(value);
}

function resolveLevels(debugLevel: DebugLevelInput): Record<string, string> {
  if (debugLevel === "default") return resolveAllDefaults();
  if (isLogLevel(debugLevel)) return allCategoriesAt(debugLevel);
  return toSObjectFields(debugLevel);
}

function allCategoriesAt(level: LogLevel) {
  return toSObjectFields({
    apexCode: level,
    apexProfiling: level,
    callout: level,
    database: level,
    nba: level,
    system: level,
    validation: level,
    visualforce: level,
    wave: level,
    workflow: level,
  });
}

type DebugLevelRecord = {
  Id: string;
};

function toSObjectFields(config: TraceConfig) {
  const entries: Record<string, string> = {};
  if (config.apexCode !== undefined) entries.ApexCode = config.apexCode;
  if (config.apexProfiling !== undefined)
    entries.ApexProfiling = config.apexProfiling;
  if (config.callout !== undefined) entries.Callout = config.callout;
  if (config.database !== undefined) entries.Database = config.database;
  if (config.nba !== undefined) entries.Nba = config.nba;
  if (config.system !== undefined) entries.System = config.system;
  if (config.validation !== undefined) entries.Validation = config.validation;
  if (config.visualforce !== undefined)
    entries.Visualforce = config.visualforce;
  if (config.wave !== undefined) entries.Wave = config.wave;
  if (config.workflow !== undefined) entries.Workflow = config.workflow;
  return entries;
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
     WHERE DeveloperName = '${MCP_DEBUG_LEVEL_NAME}'
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
    DeveloperName: MCP_DEBUG_LEVEL_NAME,
    MasterLabel: MCP_DEBUG_LEVEL_NAME,
    ...levels,
  });

  if (!result.success || !result.id) {
    throw new Error("Failed to create DebugLevel");
  }

  return result.id;
}
