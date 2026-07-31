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

/** Durations are reported in ms; 3dp keeps microsecond resolution without float noise. */
export function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Percentages are only ever read as a magnitude, so 1dp is plenty. */
export function roundPercent(percent: number): number {
  return Math.round(percent * 10) / 10;
}

/**
 * A value that tells the reader nothing the omission wouldn't.
 *
 * `false` is deliberately not empty: it is an answer.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === 0 || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Drop the keys that carry no information.
 *
 * For occurrence lists and optional sections only — issues found,
 * recommendations made, errors encountered — where an absent key unambiguously
 * means "nothing occurred". Never pass fixed-schema scalars through this: an
 * absent count cannot be told apart from a count that was never parsed, so a
 * zero is reported as a zero.
 */
export function omitEmpty<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => !isEmptyValue(value)),
  ) as Partial<T>;
}

export interface LimitRow {
  name: string;
  used: number;
  limit: number;
}

/**
 * Flatten the parser's governor limits into rows.
 *
 * All limits are kept, including those at zero — the set is fixed and known, so
 * a missing row would be a question the caller cannot answer. The saving comes
 * from the shape: as rows sharing three keys, TOON emits one header plus one
 * line per limit, which on a real log is a little over half the cost of the same
 * data as thirteen nested objects.
 */
export function toLimitRows(governorLimits: GovernorLimits): LimitRow[] {
  return Object.entries(governorLimits)
    .filter(([name]) => name !== "byNamespace")
    .map(([name, value]) => {
      const { used, limit } = value as Limits[keyof Limits];
      return { name, used, limit };
    });
}
