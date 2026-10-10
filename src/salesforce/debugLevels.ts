import { createHash } from "node:crypto";
import type { Connection } from "@salesforce/core";
import { LOG_LEVEL } from "@apexdevtools/apex-log-parser";
import type { DebugLevels } from "@apexdevtools/apex-log-parser";
import type { Assert } from "../compileGuards.js";
import { saveErrorText } from "./deleteResults.js";
import { quote } from "./soql.js";

const DEBUG_LEVEL_SOBJECT = "DebugLevel";
export const DEBUG_LEVEL_NAME = "Apex_Log_MCP_Debug_Level";

type DebugLevelRecord = Record<string, unknown> & { Id: string };

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
 * as input - so a category a caller reads back is a category it can ask for.
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
 * named. `toFieldName` capitalises them.
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
 * Salesforce side of the server speaks. No response uses it - they all use
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

/**
 * Compile guard for the other direction: every `satisfies` above only checks
 * that what is named exists, never that nothing is missing. A category the
 * parser adds has to reach `DEBUG_CATEGORIES`, or `declaredLevels` drops it
 * from every response and `apexlog_get_summary` loses its row, and no other check
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

export type DebugLevelInput = "traceFlag" | "default" | LogLevel | TraceConfig;

/** Levels grouped by level, short enough for the wire: "apexCode, workflow FINE; callout DEBUG". */
export function levelsClause(levels: Required<TraceConfig>): string {
  const byLevel = TRACE_CATEGORIES.reduce(
    (acc, category) =>
      acc.set(levels[category], [
        ...(acc.get(levels[category]) ?? []),
        category,
      ]),
    new Map<string, string[]>(),
  );
  return [...byLevel]
    .map(([level, categories]) => `${categories.join(", ")} ${level}`)
    .join("; ");
}

/** The levels a call asks for itself: a bare level, or the named categories over the defaults. */
export function requestedLevels(
  debugLevel: LogLevel | TraceConfig,
): Required<TraceConfig> {
  return typeof debugLevel === "string"
    ? (Object.fromEntries(
        TRACE_CATEGORIES.map((category) => [category, debugLevel]),
      ) as Required<TraceConfig>)
    : { ...DEFAULT_TRACE_CONFIG, ...debugLevel };
}

/** Every DebugLevel field name is the category with its first letter capitalised. */
function toFieldName(category: TraceCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/** The `DebugLevel` fields that hold the levels, for a query to select. */
export const DEBUG_LEVEL_FIELDS = TRACE_CATEGORIES.map(toFieldName);

/** The levels a selected `DebugLevel` record carries; a field it leaves empty reads as the default. */
export function toTraceConfig(
  record: Record<string, unknown> | null,
): Required<TraceConfig> {
  return Object.fromEntries(
    TRACE_CATEGORIES.map((category) => [
      category,
      record?.[toFieldName(category)] ?? DEFAULT_TRACE_CONFIG[category],
    ]),
  ) as Required<TraceConfig>;
}

/**
 * Find or create the server's DebugLevel, for the trace flag a run creates so
 * Salesforce stores its log. Its levels never decide the run's: the header
 * carries those, and beats a `USER_DEBUG` flag - see .claude/rules/trace-flags.md.
 */
export async function ensureDebugLevel(connection: Connection): Promise<string> {
  return (
    await ensureNamedDebugLevel(connection, DEBUG_LEVEL_NAME, DEFAULT_TRACE_CONFIG)
  ).Id;
}

/**
 * Find or create a DebugLevel holding exactly these levels, for a flag a
 * person asked for. Named by a digest of the levels, so the same levels reuse
 * one record; one edited since to other levels is refused, not used.
 */
export async function ensureLevelsDebugLevel(
  connection: Connection,
  levels: Required<TraceConfig>,
): Promise<{ id: string; name: string }> {
  const digest = createHash("sha256")
    .update(TRACE_CATEGORIES.map((category) => levels[category]).join(","))
    .digest("hex")
    .slice(0, 10);
  const name = `Apex_Log_MCP_${digest}`;
  const found = await ensureNamedDebugLevel(connection, name, levels);
  const held = toTraceConfig(found);
  const edited = TRACE_CATEGORIES.filter(
    (category) => held[category] !== levels[category],
  );
  if (edited.length) {
    throw new Error(
      `DebugLevel ${name} has been edited to other levels, so a flag on it would not log at the levels asked for. In Setup, set ${edited.map((category) => `${category} back to ${levels[category]}`).join(", ")}, or pass a different debugLevel.`,
    );
  }
  return { id: found.Id, name };
}

async function ensureNamedDebugLevel(
  connection: Connection,
  name: string,
  levels: Required<TraceConfig>,
): Promise<DebugLevelRecord> {
  const find = async () =>
    (
      await connection.tooling.query<DebugLevelRecord>(
        `SELECT Id, ${DEBUG_LEVEL_FIELDS.join(", ")}
         FROM ${DEBUG_LEVEL_SOBJECT}
         WHERE DeveloperName = ${quote(name)}
         LIMIT 1`,
      )
    ).records[0];
  return (await find()) ?? (await createDebugLevel(connection, name, levels, find));
}

async function createDebugLevel(
  connection: Connection,
  name: string,
  levels: Required<TraceConfig>,
  find: () => Promise<DebugLevelRecord | undefined>,
): Promise<DebugLevelRecord> {
  const fields = Object.fromEntries(
    TRACE_CATEGORIES.map((category) => [toFieldName(category), levels[category]]),
  );
  try {
    const result = await connection.tooling.sobject(DEBUG_LEVEL_SOBJECT).create({
      DeveloperName: name,
      MasterLabel: name,
      ...fields,
    });
    if (result.success && result.id) {
      return { Id: result.id, ...fields };
    }
    throw new Error(
      result.success
        ? "Salesforce saved the debug level but returned no id."
        : `Salesforce refused the debug level: ${saveErrorText(result.errors)}`,
    );
  } catch (error) {
    // Another call may have created it (jsforce throws on the duplicate name); a failed lookup must not hide why.
    const created = await find().catch(() => undefined);
    if (!created) {
      throw error;
    }
    return created;
  }
}
