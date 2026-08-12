/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog, LogLine, LogSubCategory } from "../ApexLogParser.js";
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

/** The trace category that decides whether a kind reaches the log. */
const LOG_CATEGORY_BY_KIND: Record<OperationKind, string> = {
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

export function logCategoryOf(kind: OperationKind): string {
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
  /** Null once rows are grouped, because the calls came from several lines. */
  lineNumber: number | string | null;
  /** One, until `groupOperations` folds repeats together. */
  callCount: number;
  durationTotalNs: number;
  durationSelfNs: number;
  soqlCount: number;
  dmlCount: number;
  soslCount: number;
  /** Rows the operation touched: queried, searched, or written. */
  rowCount: number;
  thrownCount: number;
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
  const visit = (node: LogLine) => {
    const kind = kindOf(node);
    if (!kind) {
      return;
    }

    operations.push({
      kind,
      name: node.text || node.type || "Unknown",
      namespace: node.namespace || "default",
      lineNumber: node.lineNumber,
      callCount: 1,
      durationTotalNs: node.duration.total,
      durationSelfNs: node.duration.self,
      soqlCount: node.soqlCount.total,
      dmlCount: node.dmlCount.total,
      soslCount: node.soslCount.total,
      rowCount:
        node.soqlRowCount.total +
        node.dmlRowCount.total +
        node.soslRowCount.total,
      thrownCount: node.totalThrownCount,
    });
  };

  apexLog.children.forEach((child) => walkLog(child, visit));

  return operations;
}

export type GroupBy = "name" | "namespace";

/**
 * Fold repeats together, so that a query run four hundred times in a loop is
 * one row carrying its four hundred calls rather than four hundred rows the
 * ranking pushes apart.
 *
 * `kind` is part of every key. A namespace that runs both queries and methods
 * is two rows rather than one row that has to call itself mixed, and every
 * column stays true of every row in it.
 */
export function groupOperations(
  operations: Operation[],
  by: GroupBy,
): Operation[] {
  const groups = new Map<string, Operation>();

  operations.forEach((operation) => {
    const label = by === "name" ? operation.name : operation.namespace;
    const key = `${operation.kind} ${label}`;
    const group = groups.get(key);

    if (!group) {
      groups.set(key, {
        ...operation,
        name: label,
        lineNumber: by === "name" ? operation.lineNumber : null,
      });
      return;
    }

    group.callCount += 1;
    group.durationTotalNs += operation.durationTotalNs;
    group.durationSelfNs += operation.durationSelfNs;
    group.soqlCount += operation.soqlCount;
    group.dmlCount += operation.dmlCount;
    group.soslCount += operation.soslCount;
    group.rowCount += operation.rowCount;
    group.thrownCount += operation.thrownCount;
    // The calls came from several lines, and naming one of them would say the
    // repeats all happened there.
    group.lineNumber = null;
  });

  return [...groups.values()];
}
