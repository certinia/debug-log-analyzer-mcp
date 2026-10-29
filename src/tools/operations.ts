/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  eventType,
  namespaceAt,
  namespaceOf,
  textAt,
  textOf,
  totalAt,
  type ApexEvent,
  type ApexLog,
  type DebugCategory,
  type EventType,
} from "../apexLog/index.js";
import type { Assert } from "../compileGuards.js";

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
   * The parser stamps one on every timed event - pinned in
   * `tests/parserContract.test.ts` - so this is never `""` in practice.
   */
  debugCategory: DebugCategory;
  /**
   * The log's own event type, e.g. `SOQL_EXECUTE_BEGIN`. It is what the category
   * cannot say: `soql`, `sosl` and `dml` all arrive under `database`, and a
   * managed package entry under `apexCode` beside the methods it hides.
   *
   * The parser's own union, so a misspelt literal anywhere downstream fails the
   * build instead of matching nothing.
   */
  type: EventType;
  name: string;
  namespace: string;
  /**
   * The namespace of the frame that called this one, read off the direct parent
   * event. It is not always the one the operation runs in: DML is pinned to
   * `default` however it was reached, so only the caller says which package
   * drove it.
   *
   * Internal. The two differ on 2.9% of 2,469 rows of a 19 MB log with managed
   * packages throughout, and on 2 of 39,415 rows of a 39 MB one, so a column
   * would repeat `namespace` on nearly every row; `groupBy: "callerNamespace"`
   * asks the question instead. The rows that differ hold the time: DML differs
   * on 4 of 5 rows, carrying 934 of its 944 ms, and `codeUnit` on 17% of rows,
   * carrying 10,600 of its 10,904 ms.
   *
   * Read off the operation this one ran inside, which is the direct parent: a
   * parent is always a frame, and every frame ranks but the `EXECUTION_STARTED`
   * one, which is in `default`. On 1,178,604 operations of real logs the direct
   * parent and the nearest ranked ancestor agreed on every row.
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
   * Never additive across rows - one row's callees are another row's calls.
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
   * The signed `HEAP_ALLOCATE` bytes less the `HEAP_DEALLOCATE` bytes, so a
   * body that releases more than it took reads below zero.
   *
   * A managed package is the exception to "not what it called". The parser
   * gives `ENTERING_MANAGED_PKG` no children, so an allocation logged inside
   * the package window lands in the calling method's own body instead of the
   * package's row - 3 of 40 real logs that allocate put a heap line there.
   *
   * Self and not the subtree, because a subtree net is not an attribution: it
   * puts the outermost code unit at the top of 39 of 40 real logs that record
   * an allocation, and there it equals the transaction peak
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
   * The id of the event this operation was read from, so a caller can reach
   * what the operation's own columns do not carry with `apexLog.event(id)` -
   * the query plan under this one call, rather than the worst plan for its text.
   *
   * Internal, and only meaningful on an ungrouped operation: `groupOperations`
   * folds many events into one row and keeps the first member's id.
   */
  id: number;
}

/**
 * The transaction frame owns no time of its own: ranking it says only that the
 * transaction took as long as it took. It is timed and carries `apexCode`, so
 * nothing else holds it out.
 */
const FRAME_TYPES = new Set<EventType>(["EXECUTION_STARTED"]);

/** What one category's events took, of their own time. */
export interface CategorySelfTime {
  operationCount: number;
  durationSelfNs: number;
}

/**
 * Each category's operations, counted, and their self time - what
 * `listOperations` would sum to - with each transaction frame's self time
 * under the frame's own category. No operation holds a frame's time, because a
 * frame is not ranked, but it is still time the transaction spent. The parser
 * puts every frame directly on the root.
 *
 * Without building the operations: naming them makes the parser index every
 * frame's text, which on a 95 MB log is half of `apexlog_get_summary`, and the
 * summary names none.
 */
export function categorySelfTimes(apexLog: ApexLog): Map<DebugCategory, CategorySelfTime> {
  const { count, type, parent, isFrame, durationSelf } = apexLog.columns;
  const totals = new Map<DebugCategory, CategorySelfTime>();
  for (let id = 1; id <= count; id++) {
    const info = isFrame[id] ? eventType(type[id] ?? -1) : null;
    if (!info) {
      continue;
    }
    const isTransaction = FRAME_TYPES.has(info.type);
    if (isTransaction && parent[id] !== 0) {
      continue;
    }
    const total = totals.get(info.debugCategory) ?? { operationCount: 0, durationSelfNs: 0 };
    // A frame is time, not an operation, so it adds to no count.
    total.operationCount += isTransaction ? 0 : 1;
    total.durationSelfNs += durationSelf[id] ?? 0;
    totals.set(info.debugCategory, total);
  }
  return totals;
}

/**
 * What a row calls an operation. Shared, so a query plan names its query with
 * the name the ranked row carries and the caller can join the two.
 */
export function operationName(node: ApexEvent): string {
  return textOf(node) || node.type;
}

/**
 * Flatten the log into the operations it performed, parents before children.
 *
 * Every timed event becomes a row. An event left out would keep its own time
 * out of the enclosing frame's self time without becoming a row of its own, so
 * the time would be reported nowhere.
 */
export function listOperations(apexLog: ApexLog): Operation[] {
  const { columns } = apexLog;
  const { count, type, parent, isFrame, durationSelf, durationTotal } = columns;
  const operations: Operation[] = [];

  // From the columns, not the events: the parser makes an event object on each
  // read, and on a 95 MB log a walk of them took 100 ms where this takes 65.
  //
  // By id, the index of the operation each event is or ran inside, or -1 for
  // none. A parent's id is below its child's, so one pass in id order fills it.
  // Row 0 is the log, which is no operation.
  const enclosing = new Int32Array(count + 1).fill(-1);
  for (let id = 1; id <= count; id++) {
    const callerIndex = enclosing[parent[id] ?? 0] ?? -1;
    const info = eventType(type[id] ?? -1);
    // A frame is what the parser times: every event with a duration is one,
    // pinned in `tests/parserContract.test.ts`.
    if (!info || !isFrame[id] || FRAME_TYPES.has(info.type)) {
      enclosing[id] = callerIndex;
      continue;
    }

    const caller = operations[callerIndex];
    const durationSelfNs = durationSelf[id] ?? 0;
    enclosing[id] = operations.length;
    operations.push({
      debugCategory: info.debugCategory,
      type: info.type,
      // As `operationName`, which an event reads.
      name: textAt(apexLog, id, info.type) || info.type,
      namespace: namespaceAt(apexLog, id),
      callerNamespace: namespaceOf(caller),
      callCount: 1,
      durationTotalNs: durationTotal[id] ?? 0,
      durationSelfNs,
      durationSelfMaxNs: durationSelfNs,
      soqlCount: totalAt(columns.soqlCount, id),
      dmlCount: totalAt(columns.dmlCount, id),
      soslCount: totalAt(columns.soslCount, id),
      rowCount:
        totalAt(columns.soqlRowCount, id) +
        totalAt(columns.dmlRowCount, id) +
        totalAt(columns.soslRowCount, id),
      thrownCount: totalAt(columns.thrownCount, id),
      heapSelfNetBytes: columns.heapAllocated?.self[id] ?? 0,
      parent: caller ?? null,
      id,
    });
  }

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
   * `type` decides `debugCategory` - the parser stamps one category per event
   * type - so keying on the type keeps both columns true of every member. A
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
 * some other type out - where dropping `-?` instead would fail the guard on any
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
 * `durationSelfNs` - a different field.
 */
type FoldedByHand = "callCount" | "durationSelfMaxNs";

/** An event, not a figure: a group keeps its first member's, as `Operation.id` says. */
type NotFolded = "id";

/**
 * Compile guard: every number on an `Operation` has to appear in one of the
 * three groups above.
 *
 * A group is seeded from its first member, so a field added to `Operation` and
 * forgotten in the fold does not read as zero - the grouped row ships the first
 * member's value, which looks like a plausible figure. No test on another field
 * would notice, which is why this is a compile error and not a review note.
 */
export type EveryNumberFolded = Assert<
  NumericField extends
    | (typeof SUBTREE_SUMMED)[number]
    | (typeof PLAIN_SUMMED)[number]
    | FoldedByHand
    | NotFolded
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

  // The group of each member, by event id. `parent` is the log's chain, not
  // this call's. When a caller narrows the operations by category, type or
  // namespace, an ancestor outside the selection can share a group's key
  // without being in the group, and suppressing on it would report a total
  // below the row's own self time - so only a member has an entry.
  //
  // An array, not a map per ancestor: the nesting test walks every member's
  // ancestors, 22 deep on average in a 95 MB log, and a lookup at each level
  // took 350 ms over its 431,300 operations where this takes 140.
  const groupById: Operation[] = [];
  const nestedInGroup = (operation: Operation, group: Operation): boolean => {
    for (let above = operation.parent; above; above = above.parent) {
      if (groupById[above.id] === group) {
        return true;
      }
    }
    return false;
  };

  operations.forEach((operation) => {
    const key = operationGroupKey(operation, by);
    const group = groups.get(key);

    if (!group) {
      // The first member of a group cannot be nested in it: `listOperations`
      // emits an operation before the ones it called.
      const first = { ...operation, ...identityOf(operation), parent: null };
      groups.set(key, first);
      groupById[operation.id] = first;
      return;
    }
    groupById[operation.id] = group;

    group.callCount += 1;

    // Walked rather than named field by field, so the rule above and the code
    // cannot drift. That costs 41% here - 44 to 63 ms over 74,960 operations of
    // real logs, folded twice each - because a keyed read is not a named
    // one. It is paid against a parse of tens to hundreds of milliseconds, and
    // `nestedInGroup` dominates both figures.
    if (!nestedInGroup(operation, group)) {
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
