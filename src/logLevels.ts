/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * The debug log's categories and levels, as a log header states them and a
 * request asks for them. Org-free, so the analysis tools read it without the
 * org layer, and `salesforce/debugLevels.ts` writes `DebugLevel` records with it.
 */

import { LOG_LEVEL } from "./apexLog/index.js";
import type { ApexLog, DebugCategory, DebugLevels } from "./apexLog/index.js";
import type { Assert } from "./compileGuards.js";

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
 * `LOG_CATEGORIES` in `salesforce/debugLevels.ts` is the same set as the header
 * itself spells it, and is confined to the `DebugLevel` record and the SOAP envelope.
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
 * named. `salesforce/debugLevels.ts` capitalises them.
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

/** One level the log's header declared, as a response reports it. */
export interface DeclaredLevel {
  debugCategory: DebugLevelCategory;
  level: string;
}

/**
 * Every level the log's header declared, in the order the header states them.
 *
 * A category the header left out is left out here: a level has no zero, so an
 * absent row means unstated rather than off.
 */
export function declaredLevels({ debugLevels }: ApexLog): DeclaredLevel[] {
  return DEBUG_CATEGORIES.flatMap((debugCategory) => {
    const level = debugLevels[debugCategory];
    return level === undefined ? [] : [{ debugCategory, level }];
  });
}

/**
 * The level each of the named categories was captured at.
 *
 * A capture level decides what reaches the log at all, so it qualifies the
 * figures beside it: a self time under `apexCode,ERROR` is the work of
 * everything the level hid, pooled at the nearest logged boundary. On one such
 * log no `METHOD_ENTRY` was emitted, and 8,161 ms of self time landed on a
 * Visualforce page that did none of that work. The caller
 * names the categories its own figures came from, so a response states only the
 * levels that could explain them, keyed as its rows are.
 *
 * Rows, not one grouped string such as "apexCode FINE; database FINEST": the
 * string saved 6-20 tokens a response on the eval logs, but a row joins the
 * operation rows on `debugCategory`, and the shape has shipped.
 */
export function capturedAt(
  apexLog: ApexLog,
  categories: Iterable<DebugCategory>,
): DeclaredLevel[] {
  const named = new Set(categories);
  return declaredLevels(apexLog).filter(({ debugCategory }) =>
    named.has(debugCategory),
  );
}
