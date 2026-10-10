/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { DeleteResult } from "../salesforce/deleteResults.js";
import { toLongId } from "../salesforce/soql.js";

/** Each id as the API writes it, mapped to the form the caller sent. */
export function givenIds(ids: string[]): Map<string, string> {
  return new Map(ids.map((id) => [toLongId(id), id]));
}

/** `id` in the form the caller sent it, or as it is when the caller sent no ids. */
export function shownId(given: Map<string, string>, id: string): string {
  return given.get(id) ?? id;
}

/** Failures that share a cause, so one cause, such as a missing permission, is one row. */
export type FailureRow = { error: string; idCount: number; ids: string[] };

/** What a delete reports: `deleted` as the API writes each id, the lists in the form the caller sent it. */
export type DeleteReport = {
  /** The ids deleted, as the API writes them. */
  deleted: Set<string>;
  /** Ids that named nothing, or whose record was gone before the delete reached it. */
  notFoundIds: string[];
  notFoundCount: number;
  failed: FailureRow[];
  failedCount: number;
};

/**
 * A delete's results against the ids the caller sent and the records found:
 * `given` maps each id as the API writes it to the form sent, and is empty for
 * a delete by filter. Each list holds at most `idLimit` ids.
 */
export function deleteReport(
  given: Map<string, string>,
  foundIds: string[],
  results: DeleteResult[],
  idLimit: number,
): DeleteReport {
  const shown = (id: string): string => shownId(given, id);
  const found = new Set(foundIds);
  const deleted = new Set(
    results.filter((result) => !result.error && !result.alreadyGone).map((result) => result.id),
  );
  // Not a failure: a retry after a lost response finds what it deleted gone.
  const notFound = [...given]
    .filter(([id]) => !found.has(id))
    .map(([, id]) => id)
    .concat(results.filter((result) => result.alreadyGone).map(({ id }) => shown(id)));
  const byError = new Map<string, FailureRow>();
  for (const { id, error } of results) {
    if (error === undefined) {
      continue;
    }
    const row = byError.get(error) ?? { error, idCount: 0, ids: [] };
    row.idCount += 1;
    if (row.ids.length < idLimit) {
      row.ids.push(shown(id));
    }
    byError.set(error, row);
  }
  const failed = [...byError.values()];
  return {
    deleted,
    notFoundIds: notFound.slice(0, idLimit),
    notFoundCount: notFound.length,
    failed,
    failedCount: failed.reduce((total, row) => total + row.idCount, 0),
  };
}
