/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog, LogEvent } from "@apexdevtools/apex-log-parser";
import type {
  DebugCategory,
  LogEventType,
} from "@apexdevtools/apex-log-parser/types";
import {
  DEBUG_CATEGORIES,
  type DebugLevelCategory,
} from "../salesforce/debugLevels.js";
import type { Assert } from "../compileGuards.js";
import { walkLog } from "./apexLogSource.js";

/** One level the log's header declared, as a response reports it. */
export interface DeclaredLevel {
  debugCategory: DebugLevelCategory;
  level: string;
}

/**
 * Every level the log's header declared, in the order the header states them.
 *
 * A category the header left out is left out here: a level has no zero, so an
 * absent row means unstated rather than off.
 */
export function declaredLevels({ debugLevels }: ApexLog): DeclaredLevel[] {
  return DEBUG_CATEGORIES.flatMap((debugCategory) => {
    const level = debugLevels[debugCategory];
    return level === undefined ? [] : [{ debugCategory, level }];
  });
}

/**
 * The level each of the named categories was captured at.
 *
 * A capture level decides what reaches the log at all, so it qualifies the
 * figures beside it: a self time under `apexCode,ERROR` is the work of
 * everything the level hid, pooled at the nearest logged boundary. The caller
 * names the categories its own figures came from, so a response states only the
 * levels that could explain them, keyed as its rows are.
 */
export function capturedAt(
  apexLog: ApexLog,
  categories: Iterable<DebugCategory>,
): DeclaredLevel[] {
  const named = new Set(categories);
  return declaredLevels(apexLog).filter(({ debugCategory }) =>
    named.has(debugCategory),
  );
}

/**
 * One timed thing the transaction did.
 *
 * Durations stay in the parser's nanoseconds, because a caller that groups rows
 * sums them, and rounding before the sum loses more than it saves.
 */
export interface Operation {
  /**
   * The Salesforce debug log category the parser stamped on the event, which is
   * the category that decides whether the event reached the log at all. Read
   * against the levels the header declared, a missing row is then readable: no
   * `database` row beside `database NONE` means the queries were not logged,
   * and beside `database FINEST` means none ran.
   *
   * The parser stamps one on every timed event — pinned in
   * `tests/parserContract.test.ts` — so this is never `""` in practice.
   */
  debugCategory: DebugCategory;
  /**
   * The log's own event type, e.g. `SOQL_EXECUTE_BEGIN`. It is what the category
   * cannot say: `soql`, `sosl` and `dml` all arrive under `database`, and a
   * managed package entry under `apexCode` beside the methods it hides.
   *
   * The parser's own union, so a misspelt literal anywhere downstream fails the
   * build instead of matching nothing. `"Unknown"` covers the events the parser
   * leaves untyped.
   */
  type: LogEventType | "Unknown";
  name: string;
  namespace: string;
  /**
   * The namespace of the frame that called this one, read off the direct parent
   * event. It is not always the one the operation runs in: DML is pinned to
   * `default` however it was reached, so only the caller says which package
   * drove it.
   *
   * Internal. The two are the same on all but a few percent of rows, so a
   * column would cost every response for an answer almost none of them carry;
   * `groupBy: "callerNamespace"` asks the question instead.
   */
  callerNamespace: string;
  /** One, until `groupOperations` folds repeats together. */
  callCount: number;
  /**
   * Time in the operation and in everything it called. Once rows are grouped it
   * is what the transaction takes back if the group never runs: only the members
   * that ran outside every other member add their total, or time inside a group
   * would count once for the child and again for every ancestor above it.
   *
   * Never additive across rows — one row's callees are another row's calls.
   */
  durationTotalNs: number;
  durationSelfNs: number;
  /**
   * The self time of the slowest single call in the group. Read against
   * `durationSelfNs` it separates one bad call from sheer volume, which need
   * opposite fixes and read alike from a sum and a count.
   */
  durationSelfMaxNs: number;
  /**
   * What the operation and everything it called did. Grouped and never additive
   * across rows, on the same rule as `durationTotalNs`.
   */
  soqlCount: number;
  dmlCount: number;
  soslCount: number;
  /** Rows the operation touched: queried, searched, or written. */
  rowCount: number;
  thrownCount: number;
  /**
   * Net heap the operation's own body retained, and not what it called.
   *
   * The signed `HEAP_ALLOCATE` bytes, so a negative allocation is the free that
   * brings the figure down and a body that releases more than it took reads
   * below zero. `HEAP_DEALLOCATE` is *not* counted: the parser reads its bytes
   * and drops them. No log in the corpus emits one, so nothing under-reads
   * today, but a log that did would read as retaining what it freed.
   *
   * A managed package is the exception to "not what it called". The parser
   * gives `ENTERING_MANAGED_PKG` no children, so an allocation logged inside
   * the package window lands in the calling method's own body instead of the
   * package's row — 3 of the 40 logs that allocate put a heap line there.
   *
   * Self and not the subtree, because a subtree net is not an attribution: it
   * puts the outermost code unit at the top of 39 of the 40 logs in a 123-log
   * corpus that record an allocation, and there it equals the transaction peak
   * `apexlog_get_summary` already reports on 36 of them. A self net names a
   * method on 27 of the 40 and matches that peak on 3.
   *
   * A plain sum once grouped, like `durationSelfNs`: one member's own body is
   * never inside another's, so no member can be counted twice.
   */
  heapSelfNetBytes: number;
  /**
   * The operation this one ran inside, or null at the top of the log. It is how
   * a group tells a nested member from an outer one, and it never reaches a
   * response.
   */
  parent: Operation | null;
  /**
   * The event this operation was read from, so a caller can reach what the
   * operation's own columns do not carry — the query plan under this one call,
   * rather than the worst plan for its text.
   *
   * Internal, and only meaningful on an ungrouped operation: `groupOperations`
   * folds many events into one row and keeps the first member's node.
   */
  node: LogEvent;
}

/**
 * The transaction frame owns no time of its own: ranking it says only that the
 * transaction took as long as it took. It is timed and carries `apexCode`, so
 * nothing else holds it out.
 */
const FRAME_TYPES = new Set<LogEventType>(["EXECUTION_STARTED"]);

/**
 * Whether the event is a thing the transaction spent time on.
 *
 * The timeline `category` is read as nothing but "this event has a duration" —
 * the parser assigns one in the `DurationLogEvent` constructor alone, and
 * publishes no other flag for it. What the event *is* comes from
 * `debugCategory` and `type`. Untimed events are most of a log, so this is both
 * the cheap test and the first one.
 */
function isRankable({ category, type }: LogEvent): boolean {
  return category !== "" && !(type && FRAME_TYPES.has(type));
}

/**
 * What a row calls an operation. Shared, so a query plan names its query with
 * the name the ranked row carries and the caller can join the two.
 */
export function operationName(node: LogEvent): string {
  return node.text || node.type || "Unknown";
}

/**
 * Flatten the log into the operations it performed, parents before children.
 *
 * Every timed event becomes a row. An event left out would keep its own time
 * out of the enclosing frame's self time without becoming a row of its own, so
 * the time would be reported nowhere.
 */
export function listOperations(apexLog: ApexLog): Operation[] {
  const operations: Operation[] = [];

  // The children, not the log: the root is a pseudo node the parser adds, and
  // it holds the whole transaction as its own time.
  //
  // The visitor hands its children the operation they ran inside, which is the
  // one it just made, or its own when the node itself is untimed.
  const visit = (node: LogEvent, parent: Operation | undefined) => {
    if (!isRankable(node)) {
      return parent;
    }

    const operation: Operation = {
      debugCategory: node.debugCategory,
      type: node.type ?? "Unknown",
      name: operationName(node),
      namespace: node.namespace || "default",
      callerNamespace: node.parent?.namespace || "default",
      callCount: 1,
      durationTotalNs: node.duration.total,
      durationSelfNs: node.duration.self,
      durationSelfMaxNs: node.duration.self,
      soqlCount: node.soqlCount.total,
      dmlCount: node.dmlCount.total,
      soslCount: node.soslCount.total,
      rowCount:
        node.soqlRowCount.total +
        node.dmlRowCount.total +
        node.soslRowCount.total,
      thrownCount: node.thrownCount.total,
      heapSelfNetBytes: node.heapAllocated.self,
      parent: parent ?? null,
      node,
    };
    operations.push(operation);

    return operation;
  };

  apexLog.children.forEach((child) =>
    walkLog<Operation | undefined>(child, visit),
  );

  return operations;
}

/** What a fold can key on, so the tool schema cannot drift from this module. */
export const GROUP_BY = [
  "name",
  "namespace",
  "callerNamespace",
  "debugCategory",
] as const;

export type GroupBy = (typeof GROUP_BY)[number];

/** Everything a grouping decides, so a new one cannot be half-defined. */
interface Grouping {
  /**
   * What a folded row calls itself. Folding on a namespace puts it in `name`
   * too, because the calls underneath it no longer share a name of their own,
   * and folding on a category does the same with the category.
   */
  identity: (operation: Operation) => { namespace: string; name: string };
  /**
   * Whether the key carries the event `type` beside that identity, which is
   * also whether a row may state the type and a name of its own: a row can
   * state only what its key holds true of every member.
   *
   * `type` decides `debugCategory` — the parser stamps one category per event
   * class — so keying on the type keeps both columns true of every member. A
   * category fold keys on the category alone, and states neither: one type
   * named would be the first member's alone, and the name would restate the
   * category.
   */
  keysOnType: boolean;
  /**
   * Whether that `name` is the operation's own, so a query plan can point at
   * the row instead of repeating the query text.
   */
  namesOperation: boolean;
}

export const GROUPINGS: Record<GroupBy, Grouping> = {
  name: {
    identity: (operation) => ({
      namespace: operation.namespace,
      name: operation.name,
    }),
    keysOnType: true,
    namesOperation: true,
  },
  namespace: {
    identity: (operation) => ({
      namespace: operation.namespace,
      name: operation.namespace,
    }),
    keysOnType: true,
    namesOperation: false,
  },
  callerNamespace: {
    identity: (operation) => ({
      namespace: operation.callerNamespace,
      name: operation.callerNamespace,
    }),
    keysOnType: true,
    namesOperation: false,
  },
  debugCategory: {
    identity: (operation) => ({
      namespace: operation.namespace,
      name: operation.debugCategory,
    }),
    keysOnType: false,
    namesOperation: false,
  },
};

/**
 * Ranking each call on its own, which folds nothing and so states everything.
 * It has no identity or key of its own: two identical calls stay two rows.
 */
export const UNGROUPED = {
  keysOnType: true,
  namesOperation: true,
} as const satisfies Omit<Grouping, "identity">;

/**
 * The row an operation folds into under a grouping. Two operations share a row
 * if and only if they share this key, so a caller that has to say which
 * operations are behind a returned row can ask rather than reproduce the rule.
 */
export function operationGroupKey(operation: Operation, by: GroupBy): string {
  const { identity, keysOnType } = GROUPINGS[by];
  const { namespace, name } = identity(operation);
  return `${keysOnType ? operation.type : ""} ${namespace} ${name}`;
}

/**
 * Every number an `Operation` carries, optional ones included.
 *
 * `NonNullable` is what reaches an optional field: `Operation[K]` on `f?: number`
 * is `number | undefined`, which does not extend `number`, so a plain test drops
 * it from this union and the guard below passes while the fold ignores it.
 * Stripping `undefined` first keeps the field in, and leaves an optional field of
 * some other type out — where dropping `-?` instead would fail the guard on any
 * optional field, numeric or not.
 */
type NumericField = {
  [K in keyof Operation]-?: NonNullable<Operation[K]> extends number ? K : never;
}[keyof Operation];

/**
 * Subtree totals: what the operation and everything it called did.
 *
 * A member that ran inside another member of the group is already inside that
 * ancestor's figure, so adding it counts the same query, statement, row or
 * throw once per level of the stack above it. `groupOperations` suppresses
 * these for a nested member and no others.
 */
const SUBTREE_SUMMED = [
  "durationTotalNs",
  "soqlCount",
  "dmlCount",
  "soslCount",
  "rowCount",
  "thrownCount",
] as const;

/**
 * Figures that exclude what the operation called, so every member adds its own
 * and nesting cannot double-count.
 */
const PLAIN_SUMMED = ["durationSelfNs", "heapSelfNetBytes"] as const;

/**
 * Folded by hand, because neither is a sum of itself: `callCount` counts the
 * members rather than adding a field, and `durationSelfMaxNs` maxes over
 * `durationSelfNs` — a different field.
 */
type FoldedByHand = "callCount" | "durationSelfMaxNs";

/**
 * Compile guard: every number on an `Operation` has to appear in one of the
 * three groups above.
 *
 * A group is seeded from its first member, so a field added to `Operation` and
 * forgotten in the fold does not read as zero — the grouped row ships the first
 * member's value, which looks like a plausible figure. No test on another field
 * would notice, which is why this is a compile error and not a review note.
 */
export type EveryNumberFolded = Assert<
  NumericField extends
    | (typeof SUBTREE_SUMMED)[number]
    | (typeof PLAIN_SUMMED)[number]
    | FoldedByHand
    ? true
    : false
>;

/**
 * Fold repeats together, so that a query run four hundred times in a loop is
 * one row carrying its four hundred calls rather than four hundred rows the
 * ranking pushes apart.
 *
 * A key that carries the event type keeps a namespace that runs both queries
 * and methods as two rows, rather than one that has to call itself
 * mixed. Beside it sits the grouping's identity, so two operations that share a
 * name in different namespaces stay apart rather than merging under whichever
 * namespace was seen first.
 */
export function groupOperations(
  operations: Operation[],
  by: GroupBy,
): Operation[] {
  const groups = new Map<string, Operation>();
  const identityOf = GROUPINGS[by].identity;

  // `parent` is the log's chain, not this call's. When a caller narrows the
  // operations by category, type or namespace, an ancestor outside the selection
  // can share a group's key without being in the group, and suppressing on it
  // would report a total below the row's own self time.
  const members = new Set(operations);

  // Memoized: the nesting test walks the ancestors of every member, and a deep
  // Apex stack would otherwise rebuild the same key at every level of it.
  const keys = new Map<Operation, string>();
  const keyOf = (operation: Operation): string => {
    const known = keys.get(operation);
    if (known !== undefined) {
      return known;
    }

    const key = operationGroupKey(operation, by);
    keys.set(operation, key);
    return key;
  };

  const nestedInGroup = (operation: Operation, key: string): boolean =>
    operation.parent !== null &&
    ((members.has(operation.parent) && keyOf(operation.parent) === key) ||
      nestedInGroup(operation.parent, key));

  operations.forEach((operation) => {
    const key = keyOf(operation);
    const group = groups.get(key);

    if (!group) {
      // The first member of a group cannot be nested in it: `listOperations`
      // emits an operation before the ones it called.
      groups.set(key, {
        ...operation,
        ...identityOf(operation),
        parent: null,
      });
      return;
    }

    group.callCount += 1;

    // Walked rather than named field by field, so the rule above and the code
    // cannot drift. That costs 41% here — 44 to 63 ms over 74,960 operations of
    // six real logs, folded twice each — because a keyed read is not a named
    // one. It is paid against a parse of tens to hundreds of milliseconds, and
    // `nestedInGroup` dominates both figures.
    if (!nestedInGroup(operation, key)) {
      for (const field of SUBTREE_SUMMED) {
        group[field] += operation[field];
      }
    }
    for (const field of PLAIN_SUMMED) {
      group[field] += operation[field];
    }

    group.durationSelfMaxNs = Math.max(
      group.durationSelfMaxNs,
      operation.durationSelfNs,
    );
  });

  return [...groups.values()];
}
