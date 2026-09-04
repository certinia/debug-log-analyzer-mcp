/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog, LogEvent } from "@apexdevtools/apex-log-parser";
// Renamed: the parser's `LogCategory` is a timeline grouping, not the debug log
// category of the same name in `salesforce/debugLevels.js`.
import type { LogCategory as TimelineCategory } from "@apexdevtools/apex-log-parser/types";
import {
  DEBUG_LEVEL_FIELD_BY_CATEGORY,
  LOG_CATEGORIES,
  type LogCategory,
} from "../salesforce/debugLevels.js";
import { walkLog } from "./apexLogSource.js";

/**
 * What the log spent time on. Every timed node the parser produces falls into
 * one of these, so a tool that ranks operations can rank all of them.
 *
 * This is not the debug log category: `category` is a timeline grouping, and
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
  "callout",
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
const LOG_CATEGORY_BY_KIND = {
  codeUnit: "APEX_CODE",
  managedPackage: "APEX_CODE",
  method: "APEX_CODE",
  systemMethod: "SYSTEM",
  soql: "DB",
  sosl: "DB",
  dml: "DB",
  callout: "CALLOUT",
  flow: "WORKFLOW",
  workflow: "WORKFLOW",
  // `satisfies` rather than an annotation: the value type has to stay the four
  // categories these kinds name, so `LEVEL_FIELD_BY_CATEGORY` covers exactly
  // them.
} as const satisfies Record<OperationKind, LogCategory>;

export function logCategoryOf(kind: OperationKind): LogCategory {
  return LOG_CATEGORY_BY_KIND[kind];
}

/**
 * The level each gating category was captured at, keyed as the response reports
 * it. Typed over the categories `LOG_CATEGORY_BY_KIND` produces, so a kind
 * cannot be added under a category no response states.
 */
const LEVEL_FIELD_BY_CATEGORY: Record<
  (typeof LOG_CATEGORY_BY_KIND)[OperationKind],
  keyof CaptureLevels
> = {
  APEX_CODE: "apexCodeLevel",
  SYSTEM: "systemLevel",
  DB: "dbLevel",
  CALLOUT: "calloutLevel",
  WORKFLOW: "workflowLevel",
};

const CAPTURE_LEVEL_FIELDS = Object.entries(LEVEL_FIELD_BY_CATEGORY) as [
  LogCategory,
  keyof CaptureLevels,
][];

/**
 * How much of the transaction reached the log at all.
 *
 * A field is absent when the log's header declared no level for the category:
 * a level has no zero, and naming a default would state a value the log never
 * did. Absent therefore means unstated, not off.
 */
export interface CaptureLevels {
  apexCodeLevel?: string;
  systemLevel?: string;
  dbLevel?: string;
  calloutLevel?: string;
  workflowLevel?: string;
}

/** One level the log's header declared, as a response reports it. */
export interface DeclaredLevel {
  logCategory: LogCategory;
  level: string;
}

/**
 * Every level the log's header declared, in the order the header states them.
 *
 * A category the header left out is left out here: a level has no zero, so an
 * absent row means unstated rather than off.
 */
export function declaredLevels({ debugLevels }: ApexLog): DeclaredLevel[] {
  return LOG_CATEGORIES.flatMap((logCategory) => {
    const level = debugLevels[DEBUG_LEVEL_FIELD_BY_CATEGORY[logCategory]];
    return level === undefined ? [] : [{ logCategory, level }];
  });
}

/**
 * Read the levels that gate the ranked kinds off the log's header.
 *
 * They qualify every figure in a response rather than any one row of it — a
 * self time under `APEX_CODE,ERROR` is the work of everything the capture level
 * hid, pooled at the nearest logged boundary — so each is a response-level
 * scalar, stated once.
 */
export function captureLevels({ debugLevels }: ApexLog): CaptureLevels {
  const levels: CaptureLevels = {};

  CAPTURE_LEVEL_FIELDS.forEach(([category, field]) => {
    const level = debugLevels[DEBUG_LEVEL_FIELD_BY_CATEGORY[category]];
    if (level !== undefined) {
      levels[field] = level;
    }
  });

  return levels;
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
 * transaction took as long as it took. It carries the `Apex` category, so a
 * test on category alone counts it as a method and inflates every method total.
 */
const FRAME_TYPES = new Set(["EXECUTION_STARTED"]);

/**
 * The types the category cannot tell apart.
 *
 * SOSL shares the `SOQL` category, and a search is not a query: it has its own
 * governor limit and its own fix. A managed package entry carries `Apex`, but
 * its self time is the time the package spent where the log shows nothing —
 * often most of the transaction, and never a method the caller can open.
 */
const KIND_BY_TYPE: Record<string, OperationKind> = {
  SOSL_EXECUTE_BEGIN: "sosl",
  ENTERING_MANAGED_PKG: "managedPackage",
};

/**
 * The kind each timeline category ranks as.
 *
 * `Validation` is absent because no timed event carries it, so nothing under it
 * could be ranked. Every other category must appear: an unranked timed event
 * keeps its own time out of the enclosing method's self time and never becomes
 * a row of its own, so the time is reported nowhere.
 */
const KIND_BY_CATEGORY: Partial<Record<TimelineCategory, OperationKind>> = {
  Apex: "method",
  System: "systemMethod",
  "Code Unit": "codeUnit",
  DML: "dml",
  SOQL: "soql",
  Callout: "callout",
};

/**
 * `Automation` merges what a caller has to keep apart, so the event type splits
 * flow and workflow back out. A prefix this does not know stays unranked, so a
 * category the parser widens reads as time missing rather than time filed under
 * the wrong kind.
 */
function automationKind(type: string): OperationKind | undefined {
  if (type.startsWith("FLOW_") || type.startsWith("EVENT_SERVICE_")) {
    return "flow";
  }
  return type.startsWith("WF_") ? "workflow" : undefined;
}

function kindOf({
  type,
  category,
  debugCategory,
}: LogEvent): OperationKind | undefined {
  // Only a timed event is given a category, and untimed events are most of a
  // log, so this is both the cheap test and the first one.
  if (category === "" || (type && FRAME_TYPES.has(type))) {
    return undefined;
  }

  // Next Best Action is filed under `Automation`, and is neither of the two
  // kinds that category splits into. Ranked where it was before the parser
  // named a category, so no figure moves; #138 gives it its own.
  if (debugCategory === "nba") {
    return "systemMethod";
  }

  return (
    (type ? KIND_BY_TYPE[type] : undefined) ??
    (category === "Automation"
      ? automationKind(type ?? "")
      : KIND_BY_CATEGORY[category])
  );
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
  const visit = (node: LogEvent, parent: Operation | undefined) => {
    const kind = kindOf(node);
    if (!kind) {
      return parent;
    }

    const operation: Operation = {
      kind,
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
 * The row an operation folds into under a grouping. Two operations share a row
 * if and only if they share this key, so a caller that has to say which
 * operations are behind a returned row can ask rather than reproduce the rule.
 */
export function operationGroupKey(operation: Operation, by: GroupBy): string {
  const { namespace, name } = IDENTITY_BY_GROUP[by](operation);
  return `${operation.kind} ${namespace} ${name}`;
}

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
    // Every subtree total: a member that ran inside another member of the group
    // is already inside that ancestor's, so adding it counts the same query,
    // statement, row or throw once per level of the stack above it. `callCount`
    // counts calls and `durationSelfNs` excludes children, so both stay plain
    // sums.
    if (!nestedInGroup(operation, key)) {
      group.durationTotalNs += operation.durationTotalNs;
      group.soqlCount += operation.soqlCount;
      group.dmlCount += operation.dmlCount;
      group.soslCount += operation.soslCount;
      group.rowCount += operation.rowCount;
      group.thrownCount += operation.thrownCount;
    }
    group.durationSelfNs += operation.durationSelfNs;

    group.durationSelfMaxNs = Math.max(
      group.durationSelfMaxNs,
      operation.durationSelfNs,
    );
  });

  return [...groups.values()];
}
