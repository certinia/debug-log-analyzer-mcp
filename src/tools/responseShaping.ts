/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Helpers for keeping tool responses small.
 *
 * Every token in a response is a token the calling model pays for on every turn
 * it stays in context. The saving comes from structure and from not saying the
 * same thing twice — never from dropping a fact. A field with a fixed schema is
 * always reported, even at zero: an agent asked "how many DML statements ran?"
 * must be able to answer from the payload.
 */

import type { GovernorLimits, Limits } from "../ApexLogParser.js";

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
 * For occurrence lists only — issues found, errors encountered — where an
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
  used: number;
  /** The ceiling the org allows. Zero when the log did not state one. */
  max: number;
}

/**
 * Flatten a set of governor limits into rows.
 *
 * All limits are kept, including those at zero — the set is fixed and known, so
 * a missing row would be a question the caller cannot answer. The saving comes
 * from the shape: as rows sharing three keys, TOON emits one header plus one
 * line per limit, which on a real log is a little over half the cost of the same
 * data as thirteen nested objects.
 *
 * The one flattener in the server, so no two tools can name a limit differently
 * or count a different set of them. `byNamespace` is not a limit and is dropped
 * here; `toNamespaceLimitRows` reports it.
 */
export function toLimitRows(limits: Limits | GovernorLimits): LimitRow[] {
  return Object.entries(limits)
    .filter(([name]) => name !== "byNamespace")
    .map(([name, value]) => {
      const { used, limit } = value as Limits[keyof Limits];
      return { limit: name, used, max: limit };
    });
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
 * which the whole-transaction table already answers — so a namespace with no
 * row for a limit consumed none of it. The ceiling is not reported either: the
 * parser keeps one per limit for the whole transaction, and it is in that
 * table.
 */
export function toNamespaceLimitRows(
  byNamespace: Map<string, Limits>,
): NamespaceLimitRow[] {
  return [...byNamespace].flatMap(([namespace, limits]) =>
    toLimitRows(limits)
      .filter((row) => row.used > 0)
      .map(({ limit, used }) => ({ namespace, limit, used })),
  );
}
