/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog } from "@apexdevtools/apex-log-parser";
import type { DebugLevels } from "@apexdevtools/apex-log-parser/types";
import { DEBUG_CATEGORIES } from "../src/salesforce/debugLevels";
import {
  capturedAt,
  declaredLevels,
  GROUP_BY,
  groupOperations,
  listOperations,
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
    // Both default to the empty string the parser leaves on an untimed event,
    // because that is what says "this event has no duration".
    category: spec.category ?? "",
    debugCategory: spec.debugCategory ?? "",
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
    category: "Apex",
    debugCategory: "apexCode",
    text: "Root",
    totalNs: 1_000_000_000,
    children,
  }) as ApexLog;
}

const named = (operations: Operation[]) => operations.map((o) => o.name);

/**
 * A log whose header declared these levels. The parser keys them by
 * `DebugLevels` property, which is the spelling every response uses.
 */
const logCapturedAt = (debugLevels: DebugLevels): ApexLog =>
  ({ debugLevels }) as ApexLog;

describe("listOperations", () => {
  it("ranks a query and a DML alongside methods, not below them", () => {
    const operations = listOperations(
      logOf(
        {
          type: "METHOD_ENTRY",
          category: "Apex",
          debugCategory: "apexCode",
          text: "A.run",
        },
        {
          type: "SOQL_EXECUTE_BEGIN",
          category: "SOQL",
          debugCategory: "database",
          text: "SELECT Id",
        },
        {
          type: "DML_BEGIN",
          category: "DML",
          debugCategory: "database",
          text: "DML Insert Account",
        },
      ),
    );

    expect(
      operations.map((o) => [o.debugCategory, o.type]),
    ).toEqual([
      ["apexCode", "METHOD_ENTRY"],
      ["database", "SOQL_EXECUTE_BEGIN"],
      ["database", "DML_BEGIN"],
    ]);
  });

  // Every timed event is ranked, whatever its type, and reports the category
  // the parser stamped. Which category goes with which type is pinned against a
  // real parse in `tests/parserContract.test.ts`.
  it("ranks a timed event of a type it does not know", () => {
    const operations = listOperations(
      logOf({
        type: "SOME_UNKNOWN_EVENT",
        category: "Automation",
        debugCategory: "nba",
        totalNs: 5_000_000,
      }),
    );

    expect(operations).toMatchObject([
      { type: "SOME_UNKNOWN_EVENT", debugCategory: "nba" },
    ]);
  });

  it("reports the time of a timed event that owns the whole transaction", () => {
    // A callout holds its wall time as self time, and the parser takes that out
    // of the calling method. Leave it unranked and the time is reported nowhere
    // at all.
    const operations = listOperations(
      logOf({
        type: "CODE_UNIT_STARTED",
        category: "Code Unit",
        debugCategory: "apexCode",
        text: "Svc.run()",
        totalNs: 904_000_000,
        selfNs: 2_000_000,
        children: [
          {
            type: "METHOD_ENTRY",
            category: "Apex",
            debugCategory: "apexCode",
            text: "Svc.fetch()",
            totalNs: 902_000_000,
            selfNs: 2_000_000,
            children: [
              {
                type: "CALLOUT_REQUEST",
                category: "Callout",
                debugCategory: "callout",
                text: "HttpRequest",
                totalNs: 900_000_000,
                selfNs: 900_000_000,
              },
            ],
          },
        ],
      }),
    );

    expect(operations.reduce((sum, o) => sum + o.durationSelfNs, 0)).toBe(
      904_000_000,
    );
    expect(operations.map((o) => o.type)).toContain("CALLOUT_REQUEST");
  });

  it("drops the transaction frame, which owns no time of its own", () => {
    const operations = listOperations(
      logOf({
        type: "EXECUTION_STARTED",
        category: "Apex",
        debugCategory: "apexCode",
        text: "Root",
      }),
    );

    expect(operations).toEqual([]);
  });

  it("drops the root, which the parser adds and which holds the whole log", () => {
    const root = node({
      type: null,
      category: "Apex",
      debugCategory: "apexCode",
      text: "LOG_ROOT",
      totalNs: 1_000_000_000,
    }) as ApexLog;

    expect(listOperations(root)).toEqual([]);
  });

  it("drops an untimed node, which the parser leaves with no category", () => {
    expect(listOperations(logOf({ type: "USER_INFO" }))).toEqual([]);
  });

  it("visits children, so a query inside a method is its own row", () => {
    const operations = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        category: "Apex",
        debugCategory: "apexCode",
        text: "A.run",
        children: [
          {
            type: "SOQL_EXECUTE_BEGIN",
            category: "SOQL",
            debugCategory: "database",
            text: "SELECT Id",
          },
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
        debugCategory: "apexCode",
        soqlRowCount: 100,
        dmlRowCount: 20,
        soslRowCount: 3,
      }),
    );

    expect(operation?.rowCount).toBe(123);
  });

  it("names an operation by its type when the parser gave it no text", () => {
    const [operation] = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        category: "Apex",
        debugCategory: "apexCode",
        text: null,
      }),
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
        debugCategory: "apexCode",
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
                debugCategory: "database",
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
      operations.find((operation) => operation.type === "DML_BEGIN"),
    ).toMatchObject({ callerNamespace: "Other" });
  });
});

describe("groupOperations", () => {
  const repeatedQuery = (namespace: string) => ({
    type: "SOQL_EXECUTE_BEGIN",
    category: "SOQL",
    debugCategory: "database",
    text: "SELECT Id FROM Account",
    namespace,
    totalNs: 10_000_000,
    soqlCount: 1,
    soqlRowCount: 5,
  });

  const method = (spec: Partial<NodeSpec> = {}): NodeSpec => ({
    type: "METHOD_ENTRY",
    category: "Apex",
    debugCategory: "apexCode",
    text: "A.run",
    ...spec,
  });

  /** The same category as `method`, and a different type. */
  const constructorCall = (spec: Partial<NodeSpec> = {}): NodeSpec => ({
    ...method({ type: "CONSTRUCTOR_ENTRY", text: "A.A()" }),
    ...spec,
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

    expect(groupOperations(operations, "name").map((o) => o.namespace)).toEqual([
      "default",
      "Custom",
    ]);
  });

  it("counts a nested call once, so the total stays what the group costs", () => {
    const call = (children: NodeSpec[] = []): NodeSpec =>
      method({ totalNs: 100_000_000, selfNs: 40_000_000, children });
    const operations = listOperations(logOf(call([call()])));

    expect(groupOperations(operations, "name")[0]).toMatchObject({
      callCount: 2,
      durationTotalNs: 100_000_000,
      durationSelfNs: 80_000_000,
    });
  });

  it("counts a nested call's queries, DML, searches, rows and throws once", () => {
    const call = (children: NodeSpec[] = []): NodeSpec =>
      method({
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
    const nested = (text: string, children: NodeSpec[] = []): NodeSpec =>
      method({
        text,
        namespace: "Custom",
        totalNs: 100_000_000,
        selfNs: 10_000_000,
        soqlCount: 1,
        children,
      });
    const operations = listOperations(
      logOf(nested("A.run", [nested("B.run", [nested("C.run")])])),
    );

    expect(
      groupOperations(operations, "namespace").find(
        (o) => o.type === "METHOD_ENTRY",
      ),
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
        debugCategory: "database",
        text: "DML Insert Account",
        namespace: "Custom",
        totalNs: 100_000_000,
        selfNs: 0,
        children: [
          {
            type: "CODE_UNIT_STARTED",
            category: "Code Unit",
            debugCategory: "apexCode",
            text: "Outer",
            namespace: "default",
            totalNs: 100_000_000,
            selfNs: 30_000_000,
            children: [
              {
                type: "DML_BEGIN",
                category: "DML",
                debugCategory: "database",
                text: "DML Update Account",
                namespace: "Custom",
                totalNs: 70_000_000,
                selfNs: 0,
                children: [
                  {
                    type: "CODE_UNIT_STARTED",
                    category: "Code Unit",
                    debugCategory: "apexCode",
                    text: "Inner",
                    namespace: "Custom",
                    totalNs: 40_000_000,
                  },
                  {
                    type: "CODE_UNIT_STARTED",
                    category: "Code Unit",
                    debugCategory: "apexCode",
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
        (operation) => operation.type === "CODE_UNIT_STARTED",
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
      logOf(
        method({
          text: "Custom.run",
          namespace: "Custom",
          totalNs: 50_000_000,
          children: [
            {
              type: "DML_BEGIN",
              category: "DML",
              debugCategory: "database",
              text: "DML Insert Account",
              namespace: "default",
              totalNs: 40_000_000,
            },
          ],
        }),
      ),
    );

    expect(groupOperations(operations, "callerNamespace")).toEqual([
      // The method itself was called by nothing, so it reports the root.
      expect.objectContaining({ type: "METHOD_ENTRY", name: "default" }),
      expect.objectContaining({
        type: "DML_BEGIN",
        name: "Custom",
        namespace: "Custom",
      }),
    ]);
  });

  // The case a category key would pass through: both rows are `apexCode`, so
  // keying on the category alone would fold them into one row stating the first
  // type for both, and lose the constructor's own figures.
  it("keeps two types of one category apart under a namespace grouping", () => {
    const operations = listOperations(
      logOf(
        method({ namespace: "Custom", totalNs: 30_000_000 }),
        constructorCall({ namespace: "Custom", totalNs: 20_000_000 }),
      ),
    );

    expect(
      groupOperations(operations, "namespace").map((o) => [
        o.type,
        o.durationSelfNs,
      ]),
    ).toEqual([
      ["METHOD_ENTRY", 30_000_000],
      ["CONSTRUCTOR_ENTRY", 20_000_000],
    ]);
  });

  it("folds the types of a category together when asked to group by it", () => {
    const operations = listOperations(
      logOf(
        method({ namespace: "Custom", totalNs: 30_000_000 }),
        constructorCall({ namespace: "Custom", totalNs: 20_000_000 }),
        repeatedQuery("Custom"),
      ),
    );

    expect(groupOperations(operations, "debugCategory")).toEqual([
      expect.objectContaining({
        name: "apexCode",
        namespace: "Custom",
        callCount: 2,
        durationSelfNs: 50_000_000,
      }),
      expect.objectContaining({
        name: "database",
        namespace: "Custom",
        callCount: 1,
      }),
    ]);
  });
});

describe("declaredLevels", () => {
  it("reports every declared level, in the order a header states them", () => {
    expect(
      declaredLevels(
        logCapturedAt({ database: "FINEST", apexCode: "ERROR", wave: "INFO" }),
      ),
    ).toEqual([
      { debugCategory: "apexCode", level: "ERROR" },
      { debugCategory: "database", level: "FINEST" },
      { debugCategory: "wave", level: "INFO" },
    ]);
  });

  it("leaves out a category the header never declared, rather than naming a default", () => {
    expect(declaredLevels(logCapturedAt({ database: "FINEST" }))).toEqual([
      { debugCategory: "database", level: "FINEST" },
    ]);
  });

  it("names every category the parser can declare a level for", () => {
    const everyCategory = Object.fromEntries(
      DEBUG_CATEGORIES.map((category) => [category, "FINEST"]),
    ) as DebugLevels;

    expect(declaredLevels(logCapturedAt(everyCategory))).toHaveLength(
      DEBUG_CATEGORIES.length,
    );
  });
});

describe("capturedAt", () => {
  it("reports the level of each category the caller names", () => {
    expect(
      capturedAt(
        logCapturedAt({
          apexCode: "ERROR",
          system: "FINE",
          database: "FINEST",
        }),
        ["database", "apexCode"],
      ),
    ).toEqual([
      { debugCategory: "apexCode", level: "ERROR" },
      { debugCategory: "database", level: "FINEST" },
    ]);
  });

  it("leaves out a named category the header never declared", () => {
    expect(
      capturedAt(logCapturedAt({ database: "FINEST" }), [
        "database",
        "visualforce",
      ]),
    ).toEqual([{ debugCategory: "database", level: "FINEST" }]);
  });

  it("leaves out a declared category the caller did not name", () => {
    expect(
      capturedAt(logCapturedAt({ apexProfiling: "FINEST" }), ["database"]),
    ).toEqual([]);
  });
});
