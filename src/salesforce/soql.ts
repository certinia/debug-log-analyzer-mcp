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
const SOQL_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
  '"': '\\"',
  "'": "\\'",
  "\\": "\\\\",
};

// One pass over the value, its pattern built from the table's keys, so the two cannot drift.
function escaper(table: Record<string, string>): (value: string) => string {
  const keys = Object.keys(table).join("").replace(/[\\\]^-]/g, "\\$&");
  const pattern = new RegExp(`[${keys}]`, "g");
  // Defined: the pattern matches only the table's keys.
  return (value) => value.replace(pattern, (char) => table[char]!);
}

const escapeSoql = escaper(SOQL_ESCAPES);

// A `LIKE` pattern also reads `%` and `_` as wildcards.
const escapeLike = escaper({ ...SOQL_ESCAPES, "%": "\\%", _: "\\_" });

/** A SOQL string literal: no character in the value can end it. */
export function quote(value: string): string {
  return `'${escapeSoql(value)}'`;
}

/** A SOQL `LIKE` pattern matching `value` anywhere: its own `%` and `_` match only themselves. */
export function containing(value: string): string {
  return `'%${escapeLike(value)}%'`;
}
