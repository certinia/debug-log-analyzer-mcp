import { Connection } from "@salesforce/core";
import { LOG_LEVEL } from "@apexdevtools/apex-log-parser/types";
import type { DebugLevels } from "@apexdevtools/apex-log-parser/types";

const DEBUG_LEVEL_SOBJECT = "DebugLevel";
const DEBUG_LEVEL_NAME = "Apex_Log_MCP_Debug_Level";

/** The parser also admits `""`, for an event that states no level; a request cannot ask for it. */
export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

export const LOG_LEVELS = Object.values(LOG_LEVEL);

/**
 * One Salesforce debug log category, as the `DebugLevels` key the parser reads
 * a log header into. The parser's own `DebugCategory` is this plus `""`, which
 * it uses for an event that states no category.
 */
export type DebugLevelCategory = keyof DebugLevels;

/**
 * Every debug log category, in the order a log header states them, which is
 * also the order the parser declares `DebugLevels` in.
 *
 * This is the spelling every response uses, because it is the one the parser
 * stamps on each event and the one `apexlog_execute_anonymous.debugLevel` takes
 * as input — so a category a caller reads back is a category it can ask for.
 * `LOG_CATEGORIES` below is the same set as the header itself spells it, and is
 * now confined to the `DebugLevel` record and the SOAP envelope.
 *
 * A literal and not `Object.keys`, because a type has no runtime form and the
 * tool schema needs the tuple. The guard below fails the build if the parser
 * adds a category this does not name.
 */
export const DEBUG_CATEGORIES = [
  "apexCode",
  "apexProfiling",
  "callout",
  "dataAccess",
  "database",
  "nba",
  "system",
  "validation",
  "visualforce",
  "wave",
  "workflow",
] as const satisfies readonly DebugLevelCategory[];

/**
 * The categories a `DebugLevel` record can set, lower-camel as its fields are
 * named. `toSObjectFields` capitalises them.
 *
 * A literal and not a filter over `DebugLevelCategory`, because the tool schema
 * needs the tuple: a filtered array would type as every category and let a
 * caller ask for `dataAccess`, which no field sets.
 */
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
] as const satisfies readonly DebugLevelCategory[];

export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

export type TraceConfig = Partial<Record<TraceCategory, LogLevel>>;

/**
 * The same categories as a debug log header spells them.
 *
 * A log opens with `APEX_CODE,FINE;DB,FINEST;…`, and the `DebugLevel` record and
 * the SOAP envelope name them this way too, so this is the spelling the
 * Salesforce side of the server speaks. No response uses it — they all use
 * `DEBUG_CATEGORIES`. `DATA_ACCESS` appears in a header but is not a
 * `DebugLevel` field, so nothing can set it.
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

/** Fails to compile unless `T` is `true`. */
type Assert<T extends true> = T;

/**
 * Compile guard for the other direction: every `satisfies` above only checks
 * that what is named exists, never that nothing is missing. A category the
 * parser adds has to reach `DEBUG_CATEGORIES`, or `declaredLevels` drops it
 * from every response and `timeByCategory` loses its row, and no other check
 * notices.
 */
export type EveryDebugLevelCategoryNamed = Assert<
  DebugLevelCategory extends (typeof DEBUG_CATEGORIES)[number] ? true : false
>;

/**
 * And that a new category is settable, or refused on purpose. Without this a
 * category the parser adds is silently absent from `TRACE_CATEGORIES`, which
 * reads the same as `dataAccess` being absent because no field sets it.
 */
export type EverySettableCategoryOffered = Assert<
  Exclude<DebugLevelCategory, "dataAccess"> extends TraceCategory
    ? true
    : false
>;

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
  return typeof value === "string" && (LOG_LEVELS as string[]).includes(value);
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
