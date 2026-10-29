/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * One hand-built parser event, for the suites that need a tree rather than a log.
 *
 * `tests/parserContract.test.ts` is the one that parses real log text, because
 * it exists to pin what the parser does. Everything else is testing this
 * server's reading of a tree, so it builds the tree directly - which is faster
 * and lets a case state the one field it is about.
 *
 * It lives here because the shape has to track the parser: every field a tool
 * reads has to be present or the read throws, so a field the parser adds is one
 * edit here rather than one in each suite.
 */

import type { ApexEvent, ApexLog } from "../../src/apexLog";

/** What a `SOQL_EXECUTE_EXPLAIN` line carries, as the parser leaves it. */
export type PlanSpec = {
  leadingOperationType: string | null;
  relativeCost: number | null;
  cardinality: number | null;
  sObjectCardinality: number | null;
};

/**
 * An event to build. Every field is optional and zero by default, so a case
 * sets only what it asserts on.
 *
 * `selfNs` defaults to `totalNs`, which is what a leaf looks like. The builder
 * does not subtract a child's time from its parent - the parser does that while
 * reading, and a case that cares states both.
 *
 * `isFrame` defaults to whether the event has children: a leaf is what most of
 * a log is, and an event with children is always a frame.
 */
export type NodeSpec = {
  type?: string;
  isFrame?: boolean;
  debugCategory?: string;
  text?: string | null;
  namespace?: string | null;
  lineNumber?: number | "EXTERNAL" | null;
  totalNs?: number;
  selfNs?: number;
  soqlCount?: number | null;
  dmlCount?: number | null;
  soslCount?: number | null;
  soqlRowCount?: number | null;
  dmlRowCount?: number | null;
  soslRowCount?: number | null;
  thrownCount?: number | null;
  heapSelfNetBytes?: number;
  children?: NodeSpec[];
  plan?: PlanSpec;
};

type Built = ApexEvent & {
  parent: Built | null;
  children: Built[];
  heapAllocated: { self: number; total: number };
};

const countOf = (total: number | null | undefined) =>
  total === null ? null : { total: total ?? 0, self: 0 };

const explainOf = (plan: PlanSpec) => ({ ...plan, sObjectType: null, fields: null });

/** Ids in log order from 1, as the parser numbers them: id 0 is the log. */
function build(spec: NodeSpec, ids: { next: number }): Built {
  const id = ids.next++;
  const children = (spec.children ?? []).map((child) => build(child, ids));
  const type = spec.type ?? "METHOD_ENTRY";
  const total = spec.totalNs ?? 0;
  // The parser gives a query the plan of its `SOQL_EXECUTE_EXPLAIN` child.
  const childPlan = spec.children?.find((child) => child.type === "SOQL_EXECUTE_EXPLAIN")?.plan;
  const built = {
    id,
    type,
    isFrame: spec.isFrame ?? children.length > 0,
    debugCategory: spec.debugCategory ?? "apexCode",
    text: spec.text ?? null,
    namespace: spec.namespace ?? null,
    lineNumber: spec.lineNumber ?? null,
    duration: { total, self: spec.selfNs ?? total },
    soqlCount: countOf(spec.soqlCount),
    dmlCount: countOf(spec.dmlCount),
    soslCount: countOf(spec.soslCount),
    soqlRowCount: countOf(spec.soqlRowCount),
    dmlRowCount: countOf(spec.dmlRowCount),
    soslRowCount: countOf(spec.soslRowCount),
    thrownCount: countOf(spec.thrownCount),
    // `self` is the event's own allocations and `total` adds its subtree's, as
    // the parser aggregates them - so the log's total is the transaction's net
    // heap without a case having to state it twice.
    heapAllocated: {
      self: spec.heapSelfNetBytes ?? 0,
      total: children.reduce((bytes, child) => bytes + child.heapAllocated.total, spec.heapSelfNetBytes ?? 0),
    },
    details:
      type === "SOQL_EXECUTE_BEGIN"
        ? { aggregations: null, explain: childPlan ? explainOf(childPlan) : null }
        : spec.plan
          ? explainOf(spec.plan)
          : null,
    parent: null,
    children,
  } as unknown as Built;

  children.forEach((child) => (child.parent = built));
  return built;
}

/** Every event under `events`, parents first, which is log order. */
function inLogOrder(events: readonly Built[]): Built[] {
  return events.flatMap((event) => [event, ...inLogOrder(event.children)]);
}

/** An event built as the `ApexEvent` a tool receives, at the top of its log. */
export const logEvent = (spec: NodeSpec): ApexEvent => build(spec, { next: 1 });

/**
 * A log of `children`, with the lists the parser fills beside the tree: every
 * event by id and by type, and every throw and fatal.
 */
export function rootLog(totalNs: number, ...children: NodeSpec[]): ApexLog {
  const ids = { next: 1 };
  const top = children.map((child) => build(child, ids));
  const events = inLogOrder(top);
  const heapTotal = top.reduce((bytes, event) => bytes + event.heapAllocated.total, 0);
  return {
    children: top,
    events,
    eventCount: events.length,
    event: (id: number) => events.find((event) => event.id === id) ?? null,
    ofType: (...types: string[]) => events.filter(({ type }) => types.includes(type)),
    exceptions: events.filter(({ type }) => type === "EXCEPTION_THROWN" || type === "FATAL_ERROR"),
    duration: { total: totalNs, self: totalNs },
    thrownCount: { total: 0, self: 0 },
    heapAllocated: { self: 0, total: heapTotal },
    namespaces: [],
    debugLevels: {},
    issues: [],
    unclosedFrames: [],
    isTruncated: false,
    truncation: { regions: [], totalSkippedBytes: 0 },
  } as unknown as ApexLog;
}
