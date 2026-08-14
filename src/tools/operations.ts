/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog, LogLine, LogSubCategory } from "../ApexLogParser.js";
import type { LogCategory } from "../salesforce/debugLevels.js";
import { walkLog } from "./apexLogSource.js";

/**
 * What the log spent time on. Every timed node the parser produces falls into
 * one of these, so a tool that ranks operations can rank all of them.
 *
 * This is not the debug log category: `subCategory` is a timeline grouping, and
 * `soql` and `dml` both arrive under `DB`. `logCategoryOf` maps a kind back to
 * the category that controls whether it was logged at all, so that an absence
 * is readable — `soql 0` beside `DB NONE` means "not logged", and beside
 * `DB FINEST` means "no queries ran".
 */
export const OPERATION_KINDS = [
  "codeUnit",
  "managedPackage",
  "method",
  "systemMethod",
  "soql",
  "sosl",
  "dml",
  "flow",
  "workflow",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * The category that decides whether a kind reaches the log.
 *
 * Typed as `LogCategory`, so the spelling here cannot drift from the one the
 * `debugLevels` rows carry — a caller reads `timeByKind` against them.
 */
const LOG_CATEGORY_BY_KIND: Record<OperationKind, LogCategory> = {
  codeUnit: "APEX_CODE",
  managedPackage: "APEX_CODE",
  method: "APEX_CODE",
  systemMethod: "SYSTEM",
  soql: "DB",
  sosl: "DB",
  dml: "DB",
  flow: "WORKFLOW",
  workflow: "WORKFLOW",
};

export function logCategoryOf(kind: OperationKind): LogCategory {
  return LOG_CATEGORY_BY_KIND[kind];
}

/**
 * One timed thing the transaction did.
 *
 * Durations stay in the parser's nanoseconds, because a caller that groups rows
 * sums them, and rounding before the sum loses more than it saves.
 */
export interface Operation {
  kind: OperationKind;
  name: string;
  namespace: string;
  /**
   * The namespace of the frame that called this one, which is not always the
   * one the operation runs in: DML is pinned to `default` however it was
   * reached, so only the caller says which package drove it.
   *
   * Internal. The two are the same on all but a few percent of rows, so a
   * column would cost every response for an answer almost none of them carry;
   * `groupBy: "callerNamespace"` asks the question instead.
   */
  callerNamespace: string;
  /** Once rows are grouped, the line of the slowest call in the group. */
  lineNumber: number | string | null;
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
  soqlCount: number;
  dmlCount: number;
  soslCount: number;
  /** Rows the operation touched: queried, searched, or written. */
  rowCount: number;
  thrownCount: number;
  /**
   * The operation this one ran inside, or null at the top of the log. It is how
   * a group tells a nested member from an outer one, and it never reaches a
   * response.
   */
  parent: Operation | null;
}

/**
 * The transaction frame owns no time of its own: ranking it says only that the
 * transaction took as long as it took. It carries the `Method` sub-category, so
 * a test on sub-category alone counts it as a method and inflates every method
 * total.
 */
const FRAME_TYPES = new Set(["EXECUTION_STARTED"]);

/**
 * Two types the sub-category cannot tell apart.
 *
 * SOSL shares the `SOQL` sub-category, and a search is not a query: it has its
 * own governor limit and its own fix. A managed package entry carries `Method`,
 * but its self time is the time the package spent where the log shows nothing —
 * often most of the transaction, and never a method the caller can open.
 */
const KIND_BY_TYPE: Record<string, OperationKind> = {
  SOSL_EXECUTE_BEGIN: "sosl",
  ENTERING_MANAGED_PKG: "managedPackage",
};

const KIND_BY_SUB_CATEGORY: Record<LogSubCategory, OperationKind> = {
  Method: "method",
  "System Method": "systemMethod",
  "Code Unit": "codeUnit",
  DML: "dml",
  SOQL: "soql",
  Flow: "flow",
  Workflow: "workflow",
};

function kindOf(node: LogLine): OperationKind | undefined {
  if (node.type && FRAME_TYPES.has(node.type)) {
    return undefined;
  }

  // subCategory is declared on TimedNode, a subclass, so it is read off the
  // node rather than tested with instanceof. A node without one is untimed.
  const { subCategory } = node as LogLine & { subCategory?: LogSubCategory };
  return (
    (node.type ? KIND_BY_TYPE[node.type] : undefined) ??
    (subCategory ? KIND_BY_SUB_CATEGORY[subCategory] : undefined)
  );
}

/**
 * Flatten the log into the operations it performed, parents before children.
 *
 * This is the one classification in the server: every tool is a view over this
 * list, so no two of them can disagree about what the log contains.
 */
export function listOperations(apexLog: ApexLog): Operation[] {
  const operations: Operation[] = [];

  // The children, not the log: the root is a pseudo node the parser adds, and
  // it holds the whole transaction as its own time.
  //
  // The visitor hands its children the operation they ran inside, which is the
  // one it just made, or its own when the node itself is untimed.
  const visit = (node: LogLine, parent: Operation | undefined) => {
    const kind = kindOf(node);
    if (!kind) {
      return parent;
    }

    const operation: Operation = {
      kind,
      name: node.text || node.type || "Unknown",
      namespace: node.namespace || "default",
      callerNamespace: parent?.namespace ?? "default",
      lineNumber: node.lineNumber,
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
      thrownCount: node.totalThrownCount,
      parent: parent ?? null,
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
export const GROUP_BY = ["name", "namespace", "callerNamespace"] as const;

export type GroupBy = (typeof GROUP_BY)[number];

/**
 * What a folded row calls itself, per grouping. A group is keyed on `kind` and
 * this pair, so no column can be true of one member and false of the next:
 * folding on a namespace puts it in `name` too, because the calls underneath it
 * no longer share a name of their own.
 */
const IDENTITY_BY_GROUP: Record<
  GroupBy,
  (operation: Operation) => { namespace: string; name: string }
> = {
  name: (operation) => ({
    namespace: operation.namespace,
    name: operation.name,
  }),
  namespace: (operation) => ({
    namespace: operation.namespace,
    name: operation.namespace,
  }),
  callerNamespace: (operation) => ({
    namespace: operation.callerNamespace,
    name: operation.callerNamespace,
  }),
};

/**
 * Fold repeats together, so that a query run four hundred times in a loop is
 * one row carrying its four hundred calls rather than four hundred rows the
 * ranking pushes apart.
 *
 * `kind` is part of every key, so a namespace that runs both queries and
 * methods is two rows rather than one that has to call itself mixed. Beside it
 * sits the identity from `IDENTITY_BY_GROUP`, so two operations that share a
 * name in different namespaces stay apart rather than merging under whichever
 * namespace was seen first.
 */
export function groupOperations(
  operations: Operation[],
  by: GroupBy,
): Operation[] {
  const groups = new Map<string, Operation>();
  const identityOf = IDENTITY_BY_GROUP[by];

  // `parent` is the log's chain, not this call's. When a caller narrows the
  // operations by kind or namespace, an ancestor outside the selection can share
  // a group's key without being in the group, and suppressing on it would report
  // a total below the row's own self time.
  const members = new Set(operations);

  // Memoized: the nesting test walks the ancestors of every member, and a deep
  // Apex stack would otherwise rebuild the same key at every level of it.
  const keys = new Map<Operation, string>();
  const keyOf = (operation: Operation): string => {
    const known = keys.get(operation);
    if (known !== undefined) {
      return known;
    }

    const { namespace, name } = identityOf(operation);
    const key = `${operation.kind} ${namespace} ${name}`;
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
    // A member that ran inside another member of the group is already inside the
    // group's total.
    if (!nestedInGroup(operation, key)) {
      group.durationTotalNs += operation.durationTotalNs;
    }
    group.durationSelfNs += operation.durationSelfNs;
    group.soqlCount += operation.soqlCount;
    group.dmlCount += operation.dmlCount;
    group.soslCount += operation.soslCount;
    group.rowCount += operation.rowCount;
    group.thrownCount += operation.thrownCount;

    // The row names the slowest call, which is the one a caller opens first.
    if (operation.durationSelfNs > group.durationSelfMaxNs) {
      group.durationSelfMaxNs = operation.durationSelfNs;
      group.lineNumber = operation.lineNumber;
    }
  });

  return [...groups.values()];
}
