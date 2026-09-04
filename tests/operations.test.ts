/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog } from "@apexdevtools/apex-log-parser";
import {
  ALL_LOG_CATEGORIES,
  type DebugLevels,
} from "@apexdevtools/apex-log-parser/types";
import { LOG_CATEGORIES } from "../src/salesforce/debugLevels";
import {
  captureLevels,
  GROUP_BY,
  groupOperations,
  listOperations,
  logCategoryOf,
  OPERATION_KINDS,
  type Operation,
} from "../src/tools/operations";

type NodeSpec = {
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
};

function node(spec: NodeSpec): unknown {
  const total = spec.totalNs ?? 0;
  const children = (spec.children ?? []).map(node) as { parent?: unknown }[];
  const built = {
    type: spec.type ?? null,
    ...(spec.category && { category: spec.category }),
    ...(spec.debugCategory && { debugCategory: spec.debugCategory }),
    text: spec.text ?? null,
    namespace: spec.namespace ?? "default",
    duration: { total, self: spec.selfNs ?? total },
    soqlCount: { total: spec.soqlCount ?? 0, self: 0 },
    dmlCount: { total: spec.dmlCount ?? 0, self: 0 },
    soslCount: { total: spec.soslCount ?? 0, self: 0 },
    soqlRowCount: { total: spec.soqlRowCount ?? 0, self: 0 },
    dmlRowCount: { total: spec.dmlRowCount ?? 0, self: 0 },
    soslRowCount: { total: spec.soslRowCount ?? 0, self: 0 },
    thrownCount: { total: spec.thrownCount ?? 0, self: 0 },
    heapAllocated: {
      total: spec.heapSelfNetBytes ?? 0,
      self: spec.heapSelfNetBytes ?? 0,
    },
    children,
  };

  // The parser links every child to its parent, and `callerNamespace` reads it.
  children.forEach((child) => (child.parent = built));

  return built;
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
        { type: "METHOD_ENTRY", category: "Apex", text: "A.run" },
        { type: "SOQL_EXECUTE_BEGIN", category: "SOQL", text: "SELECT Id" },
        { type: "DML_BEGIN", category: "DML", text: "DML Insert Account" },
      ),
    );

    expect(operations.map((o) => o.kind)).toEqual(["method", "soql", "dml"]);
  });

  it.each([
    ["CODE_UNIT_STARTED", "Code Unit", "codeUnit"],
    ["ENTERING_MANAGED_PKG", "Apex", "managedPackage"],
    ["METHOD_ENTRY", "Apex", "method"],
    ["SYSTEM_METHOD_ENTRY", "System", "systemMethod"],
    ["SOQL_EXECUTE_BEGIN", "SOQL", "soql"],
    ["SOSL_EXECUTE_BEGIN", "SOQL", "sosl"],
    ["DML_BEGIN", "DML", "dml"],
    ["CALLOUT_REQUEST", "Callout", "callout"],
    ["FLOW_ELEMENT_BEGIN", "Automation", "flow"],
    ["EVENT_SERVICE_PUB_BEGIN", "Automation", "flow"],
    ["WF_RULE_EVAL_BEGIN", "Automation", "workflow"],
  ])("classifies %s as %s", (type, category, kind) => {
    const [operation] = listOperations(logOf({ type, category }));

    expect(operation?.kind).toBe(kind);
  });

  // Next Best Action carries `Automation` and is neither a flow nor a workflow
  // rule. Ranking it as one would name the wrong thing to fix and the wrong
  // capture level beside it, so it is placed on its Salesforce category.
  it.each(["NBA_STRATEGY_BEGIN", "NBA_NODE_BEGIN", "NBA_SOMETHING_NEW"])(
    "places %s on its Salesforce category, not the timeline one",
    (type) => {
      const [operation] = listOperations(
        logOf({ type, category: "Automation", debugCategory: "nba" }),
      );

      expect(operation?.kind).toBe("systemMethod");
    },
  );

  /**
   * Every category the parser states, and the kind an event of it ranks as —
   * `null` where nothing is ranked. Driven by the parser's own list, so a
   * category it adds fails here rather than going unranked unnoticed.
   */
  const KIND_BY_PARSER_CATEGORY: Record<string, OperationKind | null> = {
    Apex: "method",
    System: "systemMethod",
    "Code Unit": "codeUnit",
    DML: "dml",
    SOQL: "soql",
    // Split on the event type instead; the cases above cover it.
    Automation: null,
    // No timed event carries it, so there is no time to lose.
    Validation: null,
    Callout: "callout",
  };

  it.each(ALL_LOG_CATEGORIES)("places a %s event", (category) => {
    const expected = KIND_BY_PARSER_CATEGORY[category];

    expect(expected).toBeDefined();
    const [operation] = listOperations(
      logOf({ type: "SOME_UNKNOWN_EVENT", category }),
    );

    expect(operation?.kind ?? null).toBe(expected);
  });

  it("reports the time of a timed event that owns the whole transaction", () => {
    // A callout holds its wall time as self time, and the parser takes that out
    // of the calling method. Leave the category unranked and the time is
    // reported nowhere at all.
    const operations = listOperations(
      logOf({
        type: "CODE_UNIT_STARTED",
        category: "Code Unit",
        text: "Svc.run()",
        totalNs: 904_000_000,
        selfNs: 2_000_000,
        children: [
          {
            type: "METHOD_ENTRY",
            category: "Apex",
            text: "Svc.fetch()",
            totalNs: 902_000_000,
            selfNs: 2_000_000,
            children: [
              {
                type: "CALLOUT_REQUEST",
                category: "Callout",
                text: "HttpRequest",
                totalNs: 900_000_000,
                selfNs: 900_000_000,
              },
            ],
          },
        ],
      }),
    );

    expect(
      operations.reduce((sum, o) => sum + o.durationSelfNs, 0),
    ).toBe(904_000_000);
    expect(operations.map((o) => o.kind)).toContain("callout");
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
        category: "Apex",
        text: "Root",
      }),
    );

    expect(operations).toEqual([]);
  });

  it("drops the root, which the parser adds and which holds the whole log", () => {
    const root = node({
      type: null,
      category: "Apex",
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
        category: "Apex",
        text: "A.run",
        children: [
          { type: "SOQL_EXECUTE_BEGIN", category: "SOQL", text: "SELECT Id" },
        ],
      }),
    );

    expect(named(operations)).toEqual(["A.run", "SELECT Id"]);
  });

  it("sums the rows an operation queried, searched and wrote", () => {
    const [operation] = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        category: "Apex",
        soqlRowCount: 100,
        dmlRowCount: 20,
        soslRowCount: 3,
      }),
    );

    expect(operation?.rowCount).toBe(123);
  });

  it("names an operation by its type when the parser gave it no text", () => {
    const [operation] = listOperations(
      logOf({ type: "METHOD_ENTRY", category: "Apex", text: null }),
    );

    expect(operation).toMatchObject({
      name: "METHOD_ENTRY",
      namespace: "default",
    });
  });

  it("reads the calling namespace off the direct parent, not the nearest ranked one", () => {
    const operations = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        category: "Apex",
        text: "Custom.run",
        namespace: "Custom",
        totalNs: 50_000_000,
        children: [
          {
            // Synthetic: the parser copies a namespace down, so no real log puts
            // a namespace of its own on an untimed frame. It pins the reading to
            // the direct parent even so.
            type: "VARIABLE_ASSIGNMENT",
            text: "row",
            namespace: "Other",
            children: [
              {
                type: "DML_BEGIN",
                category: "DML",
                text: "DML Insert Account",
                namespace: "default",
                totalNs: 40_000_000,
              },
            ],
          },
        ],
      }),
    );

    expect(
      operations.find((operation) => operation.kind === "dml"),
    ).toMatchObject({ callerNamespace: "Other" });
  });
});

describe("groupOperations", () => {
  const repeatedQuery = (namespace: string) => ({
    type: "SOQL_EXECUTE_BEGIN",
    category: "SOQL",
    text: "SELECT Id FROM Account",
    namespace,
    totalNs: 10_000_000,
    soqlCount: 1,
    soqlRowCount: 5,
  });

  it("folds a query repeated in a loop into one row carrying its call count", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default"), repeatedQuery("default")),
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

  it("keeps the self time of the slowest call in the group", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default"), {
        ...repeatedQuery("default"),
        totalNs: 90_000_000,
      }),
    );

    expect(groupOperations(operations, "name")[0]).toMatchObject({
      durationSelfMaxNs: 90_000_000,
    });
  });

  it("keeps one name in two namespaces apart, rather than under the first seen", () => {
    const operations = listOperations(
      logOf(repeatedQuery("default"), repeatedQuery("Custom")),
    );

    expect(
      groupOperations(operations, "name").map((o) => o.namespace),
    ).toEqual(["default", "Custom"]);
  });

  it("counts a nested call once, so the total stays what the group costs", () => {
    const call = (children: NodeSpec[] = []): NodeSpec => ({
      type: "METHOD_ENTRY",
      category: "Apex",
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

  it("counts a nested call's queries, DML, searches, rows and throws once", () => {
    const call = (children: NodeSpec[] = []): NodeSpec => ({
      type: "METHOD_ENTRY",
      category: "Apex",
      text: "A.run",
      totalNs: 100_000_000,
      selfNs: 40_000_000,
      soqlCount: 1,
      dmlCount: 1,
      soslCount: 1,
      soqlRowCount: 5,
      dmlRowCount: 2,
      soslRowCount: 1,
      thrownCount: 1,
      children,
    });
    const operations = listOperations(logOf(call([call()])));

    expect(groupOperations(operations, "name")[0]).toMatchObject({
      callCount: 2,
      soqlCount: 1,
      dmlCount: 1,
      soslCount: 1,
      rowCount: 8,
      thrownCount: 1,
    });
  });

  it("sums each body's own heap, where a subtree total counts a nesting once", () => {
    const call = (children: NodeSpec[] = []): NodeSpec => ({
      type: "METHOD_ENTRY",
      category: "Apex",
      text: "A.run",
      totalNs: 100_000_000,
      selfNs: 40_000_000,
      soqlCount: 1,
      heapSelfNetBytes: 500,
      children,
    });
    const operations = listOperations(logOf(call([call()])));

    // Heap is what each body allocated itself, so both calls add theirs. The
    // query is a subtree total, so the inner call's is already in the outer's.
    expect(groupOperations(operations, "name")[0]).toMatchObject({
      callCount: 2,
      heapSelfNetBytes: 1000,
      soqlCount: 1,
    });
  });

  it("counts a query once, not once per method above it in the stack", () => {
    const method = (text: string, children: NodeSpec[] = []): NodeSpec => ({
      type: "METHOD_ENTRY",
      category: "Apex",
      text,
      namespace: "Custom",
      totalNs: 100_000_000,
      selfNs: 10_000_000,
      soqlCount: 1,
      children,
    });
    const operations = listOperations(
      logOf(method("A.run", [method("B.run", [method("C.run")])])),
    );

    expect(
      groupOperations(operations, "namespace").find((o) => o.kind === "method"),
    ).toMatchObject({ callCount: 3, soqlCount: 1 });
  });

  /**
   * The shape a `namespace` filter reaches: the two inner code units share a
   * calling namespace with the code unit above them, which the filter drops.
   */
  const nestedAcrossANamespace = () =>
    listOperations(
      logOf({
        type: "DML_BEGIN",
        category: "DML",
        text: "DML Insert Account",
        namespace: "Custom",
        totalNs: 100_000_000,
        selfNs: 0,
        children: [
          {
            type: "CODE_UNIT_STARTED",
            category: "Code Unit",
            text: "Outer",
            namespace: "default",
            totalNs: 100_000_000,
            selfNs: 30_000_000,
            children: [
              {
                type: "DML_BEGIN",
                category: "DML",
                text: "DML Update Account",
                namespace: "Custom",
                totalNs: 70_000_000,
                selfNs: 0,
                children: [
                  {
                    type: "CODE_UNIT_STARTED",
                    category: "Code Unit",
                    text: "Inner",
                    namespace: "Custom",
                    totalNs: 40_000_000,
                  },
                  {
                    type: "CODE_UNIT_STARTED",
                    category: "Code Unit",
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
      logOf(repeatedQuery("default"), repeatedQuery("Custom")),
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
        category: "Apex",
        text: "Custom.run",
        namespace: "Custom",
        totalNs: 50_000_000,
        children: [
          {
            type: "DML_BEGIN",
            category: "DML",
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
        { type: "METHOD_ENTRY", category: "Apex", namespace: "Custom" },
        repeatedQuery("Custom"),
      ),
    );

    expect(groupOperations(operations, "namespace").map((o) => o.kind)).toEqual([
      "method",
      "soql",
    ]);
  });
});

describe("captureLevels", () => {
  // The parser keys the header's levels by `DebugLevel` field, so a case names
  // them the way the parser hands them over.
  const logCapturedAt = (debugLevels: DebugLevels): ApexLog =>
    ({ debugLevels }) as ApexLog;

  it("reports the level of every category that gates a ranked kind", () => {
    expect(
      captureLevels(
        logCapturedAt({
          apexCode: "ERROR",
          system: "FINE",
          database: "FINEST",
          workflow: "NONE",
        }),
      ),
    ).toEqual({
      apexCodeLevel: "ERROR",
      systemLevel: "FINE",
      dbLevel: "FINEST",
      workflowLevel: "NONE",
    });
  });

  it("leaves out a category the header never declared, rather than naming a default", () => {
    expect(captureLevels(logCapturedAt({ database: "FINEST" }))).toEqual({
      dbLevel: "FINEST",
    });
  });

  it("ignores a category no ranked kind is gated by", () => {
    expect(
      captureLevels(
        logCapturedAt({ apexProfiling: "FINEST", visualforce: "FINEST" }),
      ),
    ).toEqual({});
  });
});
