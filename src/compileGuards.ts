/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Assertions the compiler checks and nothing emits.
 *
 * `satisfies` only checks that what a table names exists, never that nothing is
 * missing. A guard covers the other direction — that a set the code depends on
 * is complete — so a field or a category added upstream fails the build instead
 * of quietly dropping out of a response.
 */

/**
 * Fails to compile unless `T` is `true`.
 *
 * Used as `export type X = Assert<<condition> ? true : false>`. The export is
 * what keeps it: an unused local type alias is a lint error, and the name is
 * where the reason for the check is written.
 */
export type Assert<T extends true> = T;
