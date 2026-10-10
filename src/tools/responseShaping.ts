/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Helpers for keeping tool responses small.
 *
 * Every token in a response is a token the calling model pays for on every turn
 * it stays in context. The saving comes from structure and from not saying the
 * same thing twice - never from dropping a fact. A field with a fixed schema is
 * always reported, even at zero: an agent asked "how many DML statements ran?"
 * must be able to answer from the payload.
 */

import {
  ALL_LIMIT_METRICS,
  type DebugCategory,
  type LimitMetricUnit,
  type Limits,
  type NamespaceLimits,
} from "@apexdevtools/apex-log-parser";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { encode } from "@toon-format/toon";

/** A tool's answer: `value` as one TOON text block. */
export function toonResult(value: object): CallToolResult {
  return { content: [{ type: "text", text: encode(value) }] };
}

/** The parser works in nanoseconds; every reported duration is milliseconds. */
export const NS_TO_MS = 1_000_000;

/** Durations are reported in ms; 3dp keeps microsecond resolution without float noise. */
export function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Percentages are only ever read as a magnitude, so 1dp is plenty. */
export function roundPercent(percent: number): number {
  return Math.round(percent * 10) / 10;
}

/**
 * A part's share of a whole, as a percentage.
 *
 * Zero when there is no whole to take a share of, which a log with no stated
 * duration and a limit with no stated ceiling both produce. Unrounded, because
 * a caller that sums shares must round the sum and not each term.
 */
export function percentageOf(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Drop the lists that nothing was added to.
 *
 * For occurrence lists only - issues found, errors encountered - where an
 * absent key unambiguously means "nothing occurred". The signature takes only
 * lists on purpose: a fixed-schema scalar must never go
 * through here, because an absent count cannot be told apart from a count that
 * was never parsed, so a zero is reported as a zero.
 */
export function omitEmpty<T extends Record<string, readonly unknown[]>>(
  obj: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, list]) => list.length > 0),
  ) as Partial<T>;
}

export interface LimitRow {
  limit: string;
  /**
   * The highest the limit reached, not where it ended: a counter that falls
   * mid-log would otherwise read below the figure the platform enforced.
   */
  used: number;
  /** The ceiling the org allows. Zero when the log did not state one. */
  max: number;
}

/**
 * Flatten a set of governor limits into rows.
 *
 * All limits are kept, including those at zero - the set is fixed and known, so
 * a missing row would be a question the caller cannot answer. The saving comes
 * from the shape: as rows sharing three keys, TOON emits one header plus one
 * line per limit, which on a real log is a little over half the cost of the same
 * data as thirteen nested objects.
 *
 * The one flattener in the server, so no two tools can name a limit differently
 * or count a different set of them.
 */
export function toLimitRows(limits: Limits): LimitRow[] {
  return Object.entries(limits).map(([name, value]) => {
    const { used, limit } = value as Limits[keyof Limits];
    return { limit: name, used, max: limit };
  });
}

/** English plurals for the units the parser publishes. */
const UNIT_PLURALS: Record<LimitMetricUnit, string> = {
  count: "counts",
  millisecond: "milliseconds",
  byte: "bytes",
};

/**
 * What a governor limit's numbers count, for the server `instructions`.
 *
 * Every row of a limit table is `{limit, used, max}`, so nothing on the wire
 * says that `heapSize 6000000` is bytes and not six million allocations. Said
 * once per session rather than as a `unit` column, which measured 22 to 37
 * tokens on *every* response carrying a limit table against 21 tokens once.
 *
 * Read from `ALL_LIMIT_METRICS`, so a metric the parser adds in another unit
 * cannot go unstated.
 */
export function limitUnitsClause(): string {
  const exceptions = ALL_LIMIT_METRICS.filter(
    ({ unit }) => unit !== "count",
  ).map(({ key, unit }) => `${key} in ${UNIT_PLURALS[unit]}`);

  return `every governor limit is a count except ${exceptions.join(" and ")}`;
}

/**
 * The debug log category that decides whether a limit's figure reached the log.
 *
 * `heapSize` is summed from `HEAP_ALLOCATE`, which the parser stamps `apexCode`
 * at FINER. Every other metric is read from the cumulative blocks, which are
 * `apexProfiling` - `CUMULATIVE_LIMIT_USAGE` at INFO and `LIMIT_USAGE_FOR_NS`
 * at FINEST. So the level of one of these two is what says whether a low or
 * absent figure is the transaction's or the trace flag's.
 *
 * Beside `toLimitRows`, because the same module that names a limit says what
 * gates it.
 */
export function limitGatingCategory(limit: string): DebugCategory {
  return limit === "heapSize" ? "apexCode" : "apexProfiling";
}

export interface NamespaceLimitRow {
  namespace: string;
  limit: string;
  used: number;
}

/**
 * What each namespace consumed, one row per limit it used.
 *
 * Only the limits a namespace consumed are reported. A row is an occurrence,
 * and whether a limit was measured at all is a property of the transaction,
 * which the whole-transaction table already answers - so a namespace with no
 * row for a limit consumed none of it. The ceiling is not reported either: the
 * parser keeps one per limit for the whole transaction, and it is in that
 * table.
 */
export function toNamespaceLimitRows(
  byNamespace: Map<string, NamespaceLimits>,
): NamespaceLimitRow[] {
  return [...byNamespace].flatMap(([namespace, limits]) =>
    toLimitRows(limits.peak)
      .filter((row) => row.used > 0)
      .map(({ limit, used }) => ({ namespace, limit, used })),
  );
}

/**
 * The longest name reported on a row: an operation, a query or the frame an
 * exception was thrown in.
 *
 * Names are short until they are not: across 23,456 operation rows of a 124-log corpus
 * the median is 50 characters and the p90 is 100, but the longest is 19,593 -
 * about 4,900 tokens for one row. Eliding at 400 touches 2% of rows and takes
 * the whole tail with it.
 */
export const NAME_LIMIT = 400;

/**
 * Keep the head and the tail of an over-long name, and say so in the middle.
 *
 * The middle goes rather than the end, because a query names its columns first
 * and its object last, and dropping the `FROM` clause would leave a row the
 * caller cannot identify.
 *
 * Measured in UTF-16 units, which is what the name costs to send, and cut by
 * slicing rather than by walking the string: on a name of the length above,
 * that is 0.16 microseconds against 56.
 */
export function elide(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = maxChars - 1 - head;
  // A cut inside a surrogate pair would send half a character, so step off it.
  const first = text.charCodeAt(head - 1);
  const from = first >= 0xd800 && first <= 0xdbff ? head - 1 : head;
  const last = text.charCodeAt(text.length - tail);
  const to =
    last >= 0xdc00 && last <= 0xdfff
      ? text.length - tail + 1
      : text.length - tail;
  return `${text.slice(0, from)}…${text.slice(to)}`;
}

/**
 * The most one page of rows may cost, as characters.
 *
 * About 15,000 tokens at the four-characters-a-token estimate `scripts/eval.mjs`
 * measures with, which leaves headroom under the 25,000-token response ceiling
 * a client is likely to impose. Eliding names is not enough on its own: a
 * thousand rows cost some 15,000 tokens in their numeric columns alone, so 5
 * logs in that corpus still breached the ceiling with every name capped.
 */
export const PAGE_CHAR_BUDGET = 60_000;

/**
 * What a row costs on the wire, near enough to bound a page by.
 *
 * An estimate, not the encoded length: it counts each cell and a separator,
 * where TOON also indents the row and quotes any cell holding a comma. It
 * therefore under-counts, by 3% on the worst page of a 124-log corpus - which
 * the budget's own headroom absorbs, since 60,000 characters is well under the
 * 100,000 a 25,000-token ceiling allows.
 */
export function rowCost(row: object): number {
  return Object.values(row).reduce(
    (total, cell) => total + String(cell).length + 1,
    0,
  );
}

/**
 * The rows of `items` that fit the page budget, built and costed in one pass:
 * a row the budget turns away is never built, and the rows are a prefix of
 * `items` by construction. At least one row always comes back, so one
 * enormous row is reported rather than the table quietly going empty. Rows
 * returned read against a matched count say the page was cut. `spent` counts
 * the row turned away too, so nothing else fits after a cut.
 */
export function fitPage<T, R extends object>(
  items: T[],
  toRow: (item: T) => R,
): { rows: R[]; spent: number } {
  const rows: R[] = [];
  let spent = 0;
  for (const item of items) {
    const row = toRow(item);
    const cost = rowCost(row);
    spent += cost;
    if (spent > PAGE_CHAR_BUDGET && rows.length > 0) {
      break;
    }
    rows.push(row);
  }
  return { rows, spent };
}

/** An empty or absent filter selects everything on that axis. */
export function matches(wanted: string[] | undefined, value: string): boolean {
  return !wanted?.length || wanted.includes(value);
}
