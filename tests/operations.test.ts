/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog } from "../src/apexLog";
import {
  GROUP_BY,
  groupOperations,
  listOperations,
  type Operation,
} from "../src/tools/operations";
import { rootLog, type NodeSpec } from "./support/logEvents";

/** These cases are about which operations come back, not their share of a log. */
const logOf = (...children: NodeSpec[]): ApexLog =>
  rootLog(1_000_000_000, ...children);

const named = (operations: Operation[]) => operations.map((o) => o.name);

describe("listOperations", () => {
  it("ranks a query and a DML alongside methods, not below them", () => {
    const operations = listOperations(
      logOf(
        {
          type: "METHOD_ENTRY",
          isFrame: true,
          debugCategory: "apexCode",
          text: "A.run",
        },
        {
          type: "SOQL_EXECUTE_BEGIN",
          isFrame: true,
          debugCategory: "database",
          text: "SELECT Id",
        },
        {
          type: "DML_BEGIN",
          isFrame: true,
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
  // real parse in `tests/parserContract.test.ts`. No code here names this type.
  it("ranks a timed event of a type it names nowhere", () => {
    const operations = listOperations(
      logOf({
        type: "NBA_NODE_BEGIN",
        isFrame: true,
        debugCategory: "nba",
        totalNs: 5_000_000,
      }),
    );

    expect(operations).toMatchObject([
      { type: "NBA_NODE_BEGIN", debugCategory: "nba" },
    ]);
  });

  it("reports the time of a timed event that owns the whole transaction", () => {
    // A callout holds its wall time as self time, and the parser takes that out
    // of the calling method. Leave it unranked and the time is reported nowhere
    // at all.
    const operations = listOperations(
      logOf({
        type: "CODE_UNIT_STARTED",
        isFrame: true,
        debugCategory: "apexCode",
        text: "Svc.run()",
        totalNs: 904_000_000,
        selfNs: 2_000_000,
        children: [
          {
            type: "METHOD_ENTRY",
            isFrame: true,
            debugCategory: "apexCode",
            text: "Svc.fetch()",
            totalNs: 902_000_000,
            selfNs: 2_000_000,
            children: [
              {
                type: "CALLOUT_REQUEST",
                isFrame: true,
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
        isFrame: true,
        debugCategory: "apexCode",
        text: "Root",
      }),
    );

    expect(operations).toEqual([]);
  });

  // The log holds the whole transaction as its own time; ranking it would say only that.
  it("ranks nothing for a log with no events, whatever its duration", () => {
    expect(listOperations(rootLog(1_000_000_000))).toEqual([]);
  });

  // The parser gives null where the header's level hid a count's lines; every response states a number.
  it("reports a count the log did not record as zero", () => {
    const [operation] = listOperations(
      logOf({ isFrame: true, soqlCount: null, dmlRowCount: null, thrownCount: null }),
    );

    expect(operation).toMatchObject({ soqlCount: 0, rowCount: 0, thrownCount: 0 });
  });

  it("drops a leaf, which spans no time", () => {
    expect(listOperations(logOf({ type: "USER_INFO" }))).toEqual([]);
  });

  it("visits children, so a query inside a method is its own row", () => {
    const operations = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        isFrame: true,
        debugCategory: "apexCode",
        text: "A.run",
        children: [
          {
            type: "SOQL_EXECUTE_BEGIN",
            isFrame: true,
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
        isFrame: true,
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
        isFrame: true,
        debugCategory: "apexCode",
        text: null,
      }),
    );

    expect(operation).toMatchObject({
      name: "METHOD_ENTRY",
      namespace: "default",
    });
  });

  it("reads the calling namespace off the operation it ran inside", () => {
    const operations = listOperations(
      logOf({
        type: "METHOD_ENTRY",
        isFrame: true,
        debugCategory: "apexCode",
        text: "Custom.run",
        namespace: "Custom",
        totalNs: 50_000_000,
        children: [
          {
            // Synthetic: the parser copies a namespace down, so a real child has its
            // parent's. One of its own tells this caller from the method above it.
            type: "VARIABLE_ASSIGNMENT",
            text: "row",
            namespace: "Other",
            children: [
              {
                type: "DML_BEGIN",
                isFrame: true,
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
    isFrame: true,
    debugCategory: "database",
    text: "SELECT Id FROM Account",
    namespace,
    totalNs: 10_000_000,
    soqlCount: 1,
    soqlRowCount: 5,
  });

  const method = (spec: Partial<NodeSpec> = {}): NodeSpec => ({
    type: "METHOD_ENTRY",
    isFrame: true,
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
      isFrame: true,
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
        isFrame: true,
        debugCategory: "database",
        text: "DML Insert Account",
        namespace: "Custom",
        totalNs: 100_000_000,
        selfNs: 0,
        children: [
          {
            type: "CODE_UNIT_STARTED",
            isFrame: true,
            debugCategory: "apexCode",
            text: "Outer",
            namespace: "default",
            totalNs: 100_000_000,
            selfNs: 30_000_000,
            children: [
              {
                type: "DML_BEGIN",
                isFrame: true,
                debugCategory: "database",
                text: "DML Update Account",
                namespace: "Custom",
                totalNs: 70_000_000,
                selfNs: 0,
                children: [
                  {
                    type: "CODE_UNIT_STARTED",
                    isFrame: true,
                    debugCategory: "apexCode",
                    text: "Inner",
                    namespace: "Custom",
                    totalNs: 40_000_000,
                  },
                  {
                    type: "CODE_UNIT_STARTED",
                    isFrame: true,
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
              isFrame: true,
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
