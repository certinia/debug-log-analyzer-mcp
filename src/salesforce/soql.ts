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

/** `items` in runs of at most `size`, so no `IN` list makes a query too long to send. */
export function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

/**
 * ISO 8601 in UTC to the second, as every tool writes a time and the time
 * filters take it. The org sends `+0000`, and milliseconds it never sets.
 */
export function isoSeconds(value: string): string {
  return new Date(value).toISOString().replace(".000Z", "Z");
}

/** True for something shaped as an id of the object `prefix` names: 15 or 18 letters and digits. */
export function isIdShaped(id: string, prefix: string): boolean {
  return id.startsWith(prefix) && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id);
}

/**
 * True for an id of the object `prefix` names: 15 characters, or 18 whose
 * suffix is the one the first 15 give.
 */
export function isSalesforceId(id: string, prefix: string): boolean {
  return (
    isIdShaped(id, prefix) &&
    // The suffix ignores case, so a mistyped one is refused, not silently corrected.
    (id.length === 15 || toLongId(id) === id.slice(0, 15) + id.slice(15).toUpperCase())
  );
}

const ID_SUFFIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/**
 * The 18-character form of an id, as the API returns it. A 15-character id, or
 * an 18-character one whose suffix differs in case, names the same record, so
 * without this a log would save to a second file or read as another record.
 */
export function toLongId(id: string): string {
  // The suffix is derived from the first 15, so it is rebuilt rather than trusted.
  const base = id.slice(0, 15);
  const suffix = [0, 5, 10]
    .map((start) =>
      [...base.slice(start, start + 5)].reduce(
        (bits, char, bit) => (/[A-Z]/.test(char) ? bits | (1 << bit) : bits),
        0,
      ),
    )
    .map((bits) => ID_SUFFIX_CHARS[bits])
    .join("");
  return base + suffix;
}
