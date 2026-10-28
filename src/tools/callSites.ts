/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { LineNumber } from "@apexdevtools/apex-log-parser";
import {
  CODE_FRAMES,
  membersByRankedRow,
  operationName,
  type GroupBy,
  type Operation,
} from "./operations.js";

/** The fold a call-site ranking keys its rows on, so the rows and their sites agree. */
export const CALL_SITE_FOLD = "name" satisfies GroupBy;

/** How many call sites a ranked row lists, its costliest first. */
const CALL_SITES_PER_ROW = 5;

/** What a call site is ranked on, which is what the rows are ranked on. */
export type SiteFigures = Pick<Operation, "durationSelfNs" | "heapSelfNetBytes">;

/** One place a ranked row's operation was called from, with what it cost there. */
export interface CallSite extends SiteFigures {
  /**
   * The code frame that made the call, or null when its parent is no code frame.
   * The log then holds the line, but not the frame whose code it counts in, so
   * neither is stated.
   */
  caller: string | null;
  /** `EXTERNAL` where managed code hides it, null where the log has none. */
  lineNumber: LineNumber;
  callCount: number;
}

/** The call sites behind a ranked row, and how many it has in all. */
interface RowCallSites {
  /** At most `CALL_SITES_PER_ROW`, ordered as the rows are. */
  sites: CallSite[];
  callSiteCount: number;
}

/**
 * A row's calls folded by caller and line. Keyed in two levels rather than on
 * one joined string, which made a new string to hash per call: on a 100 MB log
 * whose top ten rows held 332k calls, that took the pass from 340 ms to 250 ms.
 */
function foldSites(members: Operation[]): CallSite[] {
  const sitesByCaller = new Map<string | null, Map<LineNumber, CallSite>>();
  for (const { node, callCount, durationSelfNs, heapSelfNetBytes } of members) {
    const { parent, lineNumber } = node;
    // The direct parent: on 75 logs and 4.1M operations with a line, it was a
    // code frame on all but 433, and the nearest ancestor that was one agreed
    // with it on every other row.
    const caller =
      parent && CODE_FRAMES.has(parent.type) ? operationName(parent) : null;
    const line = caller !== null ? lineNumber : null;
    let sites = sitesByCaller.get(caller);
    if (!sites) {
      sites = new Map();
      sitesByCaller.set(caller, sites);
    }
    const known = sites.get(line);
    if (known) {
      known.callCount += callCount;
      known.durationSelfNs += durationSelfNs;
      known.heapSelfNetBytes += heapSelfNetBytes;
    } else {
      sites.set(line, { caller, lineNumber: line, callCount, durationSelfNs, heapSelfNetBytes });
    }
  }
  return [...sitesByCaller.values()].flatMap((sites) => [...sites.values()]);
}

/**
 * Where each ranked row's calls came from, keyed by the row.
 *
 * A row under `groupBy: "callSite"` folds its calls on `CALL_SITE_FOLD`, so its
 * members are the selected operations that share its key, and those are folded
 * again by caller and line. `compare` is the ranking's own order, so a heap
 * ranking lists the sites that kept the most heap.
 */
export function listCallSites(
  ranked: Operation[],
  selected: Operation[],
  compare: (a: SiteFigures, b: SiteFigures) => number,
): ReadonlyMap<Operation, RowCallSites> {
  return new Map(
    [...membersByRankedRow(selected, ranked, CALL_SITE_FOLD)].map(([row, members]) => {
      const sites = foldSites(members).sort(compare);
      return [
        row,
        { sites: sites.slice(0, CALL_SITES_PER_ROW), callSiteCount: sites.length },
      ];
    }),
  );
}
