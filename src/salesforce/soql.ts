/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

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
