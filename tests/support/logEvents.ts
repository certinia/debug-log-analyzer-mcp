/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * One hand-built parser node, for the suites that need a tree rather than a log.
 *
 * `tests/parserContract.test.ts` is the one that parses real log text, because
 * it exists to pin what the parser does. Everything else is testing this
 * server's reading of a tree, so it builds the tree directly — which is faster
 * and lets a case state the one field it is about.
 *
 * It lives here because the shape has to track the parser: every field a tool
 * reads has to be present or the read throws, so a field the parser adds is one
 * edit here rather than one in each suite.
 */

import type { ApexLog, LogEvent } from "@apexdevtools/apex-log-parser";

/** What a `SOQL_EXECUTE_EXPLAIN` line carries, as the parser leaves it. */
export type PlanSpec = {
  leadingOperationType: string | null;
  relativeCost: number | null;
  cardinality: number | null;
  sObjectCardinality: number | null;
};

/**
 * A node to build. Every field is optional and zero by default, so a case sets
 * only what it asserts on.
 *
 * `selfNs` defaults to `totalNs`, which is what a leaf looks like. The builder
 * does not subtract a child's time from its parent — the parser does that while
 * reading, and a case that cares states both.
 */
export type NodeSpec = {
  type?: string | null;
  category?: string;
  debugCategory?: string;
  text?: string | null;
  namespace?: string | null;
  totalNs?: number;
  selfNs?: number;
  soqlCount?: number;
  dmlCount?: number;
  soslCount?: number;
  soqlRowCount?: number;
  dmlRowCount?: number;
  soslRowCount?: number;
  thrownCount?: number;
  heapSelfNetBytes?: number;
  children?: NodeSpec[];
  plan?: PlanSpec;
};

/**
 * Build a node and its subtree.
 *
 * Returned as `unknown` for the caller to cast: a real `LogEvent` carries the
 * parser's whole class, and a spec that had to satisfy it would state dozens of
 * fields no case reads.
 */
export function node(spec: NodeSpec): unknown {
  const total = spec.totalNs ?? 0;
  const children = (spec.children ?? []).map(node) as {
    parent?: unknown;
    heapAllocated: { total: number };
  }[];
  const built = {
    ...spec.plan,
    type: spec.type ?? null,
    ...(spec.category && { category: spec.category }),
    ...(spec.debugCategory && { debugCategory: spec.debugCategory }),
    text: spec.text ?? null,
    namespace: spec.namespace ?? "default",
    lineNumber: null,
    duration: { total, self: spec.selfNs ?? total },
    soqlCount: { total: spec.soqlCount ?? 0, self: 0 },
    dmlCount: { total: spec.dmlCount ?? 0, self: 0 },
    soslCount: { total: spec.soslCount ?? 0, self: 0 },
    soqlRowCount: { total: spec.soqlRowCount ?? 0, self: 0 },
    dmlRowCount: { total: spec.dmlRowCount ?? 0, self: 0 },
    soslRowCount: { total: spec.soslRowCount ?? 0, self: 0 },
    thrownCount: { total: spec.thrownCount ?? 0, self: 0 },
    // `self` is the node's own allocations and `total` adds its subtree's, as
    // the parser aggregates them — so the root's total is the transaction's net
    // heap without a case having to state it twice.
    heapAllocated: {
      self: spec.heapSelfNetBytes ?? 0,
      total: children.reduce(
        (bytes, child) => bytes + child.heapAllocated.total,
        spec.heapSelfNetBytes ?? 0,
      ),
    },
    children,
  };

  // The parser links every child to its parent, and `callerNamespace` reads it.
  children.forEach((child) => (child.parent = built));

  return built;
}

/** A node built as the `LogEvent` a tool receives. */
export const logEvent = (spec: NodeSpec): LogEvent => node(spec) as LogEvent;

/**
 * A log whose root is the transaction frame the parser always emits, running
 * `children`. The frame is what `listOperations` skips, so a case's own nodes
 * are its children and never the root.
 */
export const rootLog = (totalNs: number, ...children: NodeSpec[]): ApexLog =>
  node({
    type: "EXECUTION_STARTED",
    text: "Root",
    totalNs,
    children,
  }) as ApexLog;
