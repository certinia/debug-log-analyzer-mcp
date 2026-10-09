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

/** `value` with every character SOQL reads as special in a string literal escaped. */
export function escapeSoql(value: string): string {
  // Defined: the class holds only SOQL_ESCAPES's keys.
  return value.replace(/[\n\r\t\b\f"'\\]/g, (char) => SOQL_ESCAPES[char]!);
}

/** A SOQL string literal: no character in the value can end it. */
export function quote(value: string): string {
  return `'${escapeSoql(value)}'`;
}
