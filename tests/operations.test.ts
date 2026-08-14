/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog } from "../src/ApexLogParser";
import { LOG_CATEGORIES } from "../src/salesforce/debugLevels";
import {
  GROUP_BY,
  groupOperations,
  listOperations,
  logCategoryOf,
  OPERATION_KINDS,
  type Operation,
} from "../src/tools/operations";

type NodeSpec = {
  type?: string | null;
  subCategory?: string;
  text?: string | null;
  namespace?: string | null;
  lineNumber?: number | string | null;
  totalNs?: number;
  selfNs?: number;
  soqlCount?: number;
  dmlCount?: number;
  soslCount?: number;
  soqlRowCount?: number;
  dmlRowCount?: number;
  soslRowCount?: number;
  thrownCount?: number;
  children?: NodeSpec[];
};

function node(spec: NodeSpec): unknown {
  const total = spec.totalNs ?? 0;
  return {
    type: spec.type ?? null,
    ...(spec.subCategory && { subCategory: spec.subCategory }),
    text: spec.text ?? null,
    namespace: spec.namespace ?? "default",
    lineNumber: spec.lineNumber ?? null,
    duration: { total, self: spec.selfNs ?? total },
    soqlCount: { total: spec.soqlCount ?? 0, self: 0 },
    dmlCount: { total: spec.dmlCount ?? 0, self: 0 },
    soslCount: { total: spec.soslCount ?? 0, self: 0 },
    soqlRowCount: { total: spec.soqlRowCount ?? 0, self: 0 },
    dmlRowCount: { total: spec.dmlRowCount ?? 0, self: 0 },
    soslRowCount: { total: spec.soslRowCount ?? 0, self: 0 },
    totalThrownCount: spec.thrownCount ?? 0,
    children: (spec.children ?? []).map(node),
  };
}

/** A log whose root is the transaction frame the parser always emits. */
function logOf(...children: NodeSpec[]): ApexLog {
  return node({
    type: "EXECUTION_STARTED",
    text: "Root",
    totalNs: 1_000_000_000,
    children,
  }) as ApexLog;
}

const named = (operations: Operation[]) => operations.map((o) => o.name);

describe("listOperations", () => {
  it("ranks a query and a DML alongside methods, not below them", () => {
    const operations = listOperations(
      logOf(
        { type: "METHOD_ENTRY", subCategory: "Method", text: "A.run" },
        { type: "SOQL_EXECUTE_BEGIN", subCategory: "SOQL", text: "SELECT Id" },
        { type: "DML_BEGIN", subCategory: "DML", text: "DML Insert Account" },
      ),
    );

    expect(operations.map((o) => o.kind)).toEqual(["method", "soql", "dml"]);
  });

  it.each([
    ["CODE_UNIT_STARTED", "Code Unit", "codeUnit"],
    ["ENTERING_MANAGED_PKG", "Method", "managedPackage"],
    ["METHOD_ENTRY", "Method", "method"],
    ["SYSTEM_METHOD_ENTRY", "System Method", "systemMethod"],
    ["SOQL_EXECUTE_BEGIN", "SOQL", "soql"],
    ["SOSL_EXECUTE_BEGIN", "SOQL", "sosl"],
    ["DML_BEGIN", "DML", "dml"],
    ["FLOW_ELEMENT_BEGIN", "Flow", "flow"],
    ["WF_RULE_EVAL_BEGIN", "Workflow", "workflow"],
  ])("classifies %s as %s", (type, subCategory, kind) => {
    const [operation] = listOperations(logOf({ type, subCategory }));

    expect(operation?.kind).toBe(kind);
  });

  it("covers every kind it declares", () => {
    expect(new Set(OPERATION_KINDS).size).toBe(OPERATION_KINDS.length);
    OPERATION_KINDS.forEach((kind) =>
      expect(LOG_CATEGORIES).toContain(logCategoryOf(kind)),
    );
  });

  it("drops the transaction frame, which owns no time of its own", () => {
    const operations = listOperations(
      logOf({
        type: "EXECUTION_STARTED",
        subCategory: "Method",
        text: "Root",
      }),
    );

    expect(operations).toEqual([]);
  });

  it("drops the root, which the parser adds and which holds the whole log", () => {
    const root = node({
      type: null,
      subCategory: "Method",
      text: "LOG_ROOT",
      totalNs: 1_000_000_000,
    }) as ApexLog;

    expect(listOperations(root)).toEqual([]);
  });

  it("drops an untimed node, which has no sub-category", () => {
    expect(listOperations(logOf({ type: "USER_INFO" }))).toEqual([]);
  });

  it("visits children, so a query inside a method is its own row", () => {
    const operations = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        subCategory: "Method",
        text: "A.run",
        children: [
          { type: "SOQL_EXECUTE_BEGIN", subCategory: "SOQL", text: "SELECT Id" },
        ],
      }),
    );

    expect(named(operations)).toEqual(["A.run", "SELECT Id"]);
  });

  it("sums the rows an operation queried, searched and wrote", () => {
    const [operation] = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        subCategory: "Method",
        soqlRowCount: 100,
        dmlRowCount: 20,
        soslRowCount: 3,
      }),
    );

    expect(operation?.rowCount).toBe(123);
  });

  it("names an operation by its type when the parser gave it no text", () => {
    const [operation] = listOperations(
      logOf({ type: "METHOD_ENTRY", subCategory: "Method", text: null }),
    );

    expect(operation).toMatchObject({
      name: "METHOD_ENTRY",
      namespace: "default",
    });
  });
});

describe("groupOperations", () => {
  const repeatedQuery = (namespace: string, lineNumber: number) => ({
    type: "SOQL_EXECUTE_BEGIN",
    subCategory: "SOQL",
    text: "SELECT Id FROM Account",
    namespace,
    lineNumber,
    totalNs: 10_000_000,
    soqlCount: 1,
    soqlRowCount: 5,
  });

  it("folds a query repeated in a loop into one row carrying its call count", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default", 12), repeatedQuery("default", 12)),
    );

    expect(groupOperations(operations, "name")).toEqual([
      expect.objectContaining({
        name: "SELECT Id FROM Account",
        callCount: 2,
        durationTotalNs: 20_000_000,
        soqlCount: 2,
        rowCount: 10,
      }),
    ]);
  });

  it("names the line of the slowest call, which is the one to open first", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default", 12), {
        ...repeatedQuery("default", 34),
        totalNs: 90_000_000,
      }),
    );

    expect(groupOperations(operations, "name")[0]).toMatchObject({
      lineNumber: 34,
      durationSelfMaxNs: 90_000_000,
    });
  });

  it("keeps one name in two namespaces apart, rather than under the first seen", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default", 12), repeatedQuery("Custom", 12)),
    );

    expect(
      groupOperations(operations, "name").map((o) => o.namespace),
    ).toEqual(["default", "Custom"]);
  });

  it("counts a nested call once, so the total stays what the group costs", () => {
    const call = (children: NodeSpec[] = []): NodeSpec => ({
      type: "METHOD_ENTRY",
      subCategory: "Method",
      text: "A.run",
      totalNs: 100_000_000,
      selfNs: 40_000_000,
      children,
    });
    const operations = listOperations(logOf(call([call()])));

    expect(groupOperations(operations, "name")[0]).toMatchObject({
      callCount: 2,
      durationTotalNs: 100_000_000,
      durationSelfNs: 80_000_000,
    });
  });

  /**
   * The shape a `namespace` filter reaches: the two inner code units share a
   * calling namespace with the code unit above them, which the filter drops.
   */
  const nestedAcrossANamespace = () =>
    listOperations(
      logOf({
        type: "DML_BEGIN",
        subCategory: "DML",
        text: "DML Insert Account",
        namespace: "Custom",
        totalNs: 100_000_000,
        selfNs: 0,
        children: [
          {
            type: "CODE_UNIT_STARTED",
            subCategory: "Code Unit",
            text: "Outer",
            namespace: "default",
            totalNs: 100_000_000,
            selfNs: 30_000_000,
            children: [
              {
                type: "DML_BEGIN",
                subCategory: "DML",
                text: "DML Update Account",
                namespace: "Custom",
                totalNs: 70_000_000,
                selfNs: 0,
                children: [
                  {
                    type: "CODE_UNIT_STARTED",
                    subCategory: "Code Unit",
                    text: "Inner",
                    namespace: "Custom",
                    totalNs: 40_000_000,
                  },
                  {
                    type: "CODE_UNIT_STARTED",
                    subCategory: "Code Unit",
                    text: "Inner",
                    namespace: "Custom",
                    totalNs: 30_000_000,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

  it("counts a member whose matching ancestor the caller filtered away", () => {
    const selected = nestedAcrossANamespace().filter(
      (operation) => operation.namespace === "Custom",
    );

    expect(
      groupOperations(selected, "callerNamespace").find(
        (operation) => operation.kind === "codeUnit",
      ),
    ).toMatchObject({ callCount: 2, durationTotalNs: 70_000_000 });
  });

  it("never reports a total below the self time it contains", () => {
    const operations = nestedAcrossANamespace();
    const namespaces = [undefined, "default", "Custom"];

    namespaces.forEach((namespace) =>
      GROUP_BY.forEach((by) => {
        const selected = operations.filter(
          (operation) => !namespace || operation.namespace === namespace,
        );

        groupOperations(selected, by).forEach((group) =>
          expect({
            namespace,
            by,
            name: group.name,
            impossible: group.durationTotalNs < group.durationSelfNs,
          }).toMatchObject({ impossible: false }),
        );
      }),
    );
  });

  it("groups by namespace, and names the row after it", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default", 1), repeatedQuery("Custom", 2)),
    );

    expect(groupOperations(operations, "namespace")).toEqual([
      expect.objectContaining({ name: "default", callCount: 1 }),
      expect.objectContaining({ name: "Custom", callCount: 1 }),
    ]);
  });

  it("groups by the calling namespace, which DML never carries itself", () => {
    const operations = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        subCategory: "Method",
        text: "Custom.run",
        namespace: "Custom",
        totalNs: 50_000_000,
        children: [
          {
            type: "DML_BEGIN",
            subCategory: "DML",
            text: "DML Insert Account",
            namespace: "default",
            totalNs: 40_000_000,
          },
        ],
      }),
    );

    expect(groupOperations(operations, "callerNamespace")).toEqual([
      // The method itself was called by nothing, so it reports the root.
      expect.objectContaining({ kind: "method", name: "default" }),
      expect.objectContaining({
        kind: "dml",
        name: "Custom",
        namespace: "Custom",
      }),
    ]);
  });

  it("keeps kinds apart, so every column stays true of every row", () => {
    const operations = listOperations(
      logOf(
        { type: "METHOD_ENTRY", subCategory: "Method", namespace: "Custom" },
        repeatedQuery("Custom", 3),
      ),
    );

    expect(groupOperations(operations, "namespace").map((o) => o.kind)).toEqual([
      "method",
      "soql",
    ]);
  });
});
