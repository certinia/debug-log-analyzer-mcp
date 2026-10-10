/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/** How far this machine's clock and the org's are allowed to differ. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A date the jsforce query builder renders as a SOQL date-time literal.
 *
 * The builder has a case for its own `SfDate` and none for a `Date`, which it
 * passes through `String` into prose SOQL rejects. Anything else it stringifies
 * as it stands, so a value that stringifies to ISO 8601 is the literal.
 */
export function toDateTimeLiteral(date: Date): { toString(): string } {
  return { toString: () => date.toISOString() };
}

// Every character SOQL reads as special inside a string literal, as its escape.
const SOQL_ESCAPES = new Map([
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ['"', '\\"'],
  ["'", "\\'"],
  ["\\", "\\\\"],
]);

// A `LIKE` pattern also reads `%` and `_` as wildcards.
const LIKE_ESCAPES = new Map(SOQL_ESCAPES).set("%", "\\%").set("_", "\\_");

// Each character through the table once, so nothing is escaped twice; a Map, so no inherited key can match.
function escapeWith(table: Map<string, string>, value: string): string {
  let escaped = "";
  for (const char of value) {
    escaped += table.get(char) ?? char;
  }
  return escaped;
}

/** A SOQL string literal: no character in the value can end it. */
export function quote(value: string): string {
  return `'${escapeWith(SOQL_ESCAPES, value)}'`;
}

/** A SOQL `LIKE` pattern matching `value` anywhere: its own `%` and `_` match only themselves. */
export function containing(value: string): string {
  return `'%${escapeWith(LIKE_ESCAPES, value)}%'`;
}
