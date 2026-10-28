/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { ApexLog } from "@apexdevtools/apex-log-parser";
import {
  listSlowOperationsTool,
  type SlowOperationsArgs,
  type SlowOperationsResult,
} from "../src/tools/listSlowOperations";
import { rootLog, type NodeSpec, type PlanSpec } from "./support/logEvents";

const MS = 1_000_000;

/** A log whose root is the transaction frame, and which runs `children`. */
function useLog(totalNs: number, ...children: NodeSpec[]): ApexLog {
  return {
    ...rootLog(totalNs, ...children),
    // A header these cases say nothing about, so no capture level is reported
    // and the assertions below are about the ranking alone. The eval goldens
    // cover the levels, against fixtures that carry a real header.
    debugLevels: {},
  };
}

const method = (spec: NodeSpec): NodeSpec => ({
  type: "METHOD_ENTRY",
  category: "Apex",
  debugCategory: "apexCode",
  ...spec,
});

const query = (spec: NodeSpec): NodeSpec => ({
  type: "SOQL_EXECUTE_BEGIN",
  category: "SOQL",
  debugCategory: "database",
  soqlCount: 1,
  ...spec,
});

/** A query with the optimiser's explain line beneath it, where the parser puts it. */
const explainedQuery = (spec: NodeSpec, plan: Partial<PlanSpec>): NodeSpec =>
  query({
    ...spec,
    children: [
      {
        type: "SOQL_EXECUTE_EXPLAIN",
        plan: {
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
          cardinality: 100,
          sObjectCardinality: 1000,
          ...plan,
        },
      },
    ],
  });

/** About what a set of rows costs on the wire, a cell and a separator each. */
const cost = (rows: object[]): number =>
  rows.reduce(
    (total: number, row) =>
      total +
      Object.values(row).reduce(
        (cells: number, cell) => cells + String(cell).length + 1,
        0,
      ),
    0,
  );

function ranked(
  log: ApexLog,
  args: SlowOperationsArgs = {},
): SlowOperationsResult {
  return listSlowOperationsTool.run(log, args);
}

describe("listSlowOperations", () => {
  describe("tool configuration", () => {
    it("says it ranks by self time, so a client can select it", () => {
      expect(listSlowOperationsTool.config.description).toContain(
        "self-execution time",
      );
    });

    it("takes every axis a caller narrows the ranking on", () => {
      // After logFilePath, which every analysis tool has first.
      expect(Object.keys(listSlowOperationsTool.config.inputSchema.shape).slice(1)).toEqual([
        "debugCategory",
        "type",
        "namespace",
        "minSelfMs",
        "limit",
        "offset",
        "groupBy",
        "sortBy",
      ]);
    });

  });

  it("ranks a query alongside a method, slowest self time first", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 400 * MS }),
      query({ text: "SELECT Id", totalNs: 500 * MS }),
    );

    expect(
      ranked(log).operations.map((o) => [
        o.debugCategory,
        o.type,
        o.name,
      ]),
    ).toEqual([
      ["database", "SOQL_EXECUTE_BEGIN", "SELECT Id"],
      ["apexCode", "METHOD_ENTRY", "A.run"],
    ]);
  });

  it("reports durations in milliseconds and the share of the transaction", () => {
    const log = useLog(1000 * MS, method({ text: "A.run", totalNs: 500 * MS }));

    expect(ranked(log)).toEqual({
      durationTotalMs: 1000,
      returnedSelfPercentage: 50,
      matchedCount: 1,
      operations: [
        {
          debugCategory: "apexCode",
          type: "METHOD_ENTRY",
          name: "A.run",
          namespace: "default",
          callCount: 1,
          durationTotalMs: 500,
          durationSelfMs: 500,
          durationSelfMaxMs: 500,
          selfPercentage: 50,
          soqlCount: 0,
          dmlCount: 0,
          soslCount: 0,
          rowCount: 0,
          thrownCount: 0,
        },
      ],
    });
  });

  it("says what share the returned rows account for, not what is missing", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 200 * MS }),
    );

    expect(ranked(log, { limit: 1 }).returnedSelfPercentage).toBe(
      50,
    );
  });

  it("counts what the selection matched, not what the cap returned", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 200 * MS }),
      method({ text: "C.run", totalNs: 100 * MS }),
    );

    const result = ranked(log, { limit: 1 });

    expect(result.matchedCount).toBe(3);
    expect(result.operations).toHaveLength(1);
  });

  it("counts the rows the threshold kept, not the calls behind them", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "A.run", totalNs: 200 * MS }),
      method({ text: "B.run", totalNs: 1 * MS }),
    );

    // Grouped, then filtered: two names, and only one clears the threshold.
    expect(ranked(log, { minSelfMs: 10 }).matchedCount).toBe(1);
  });

  it("returns no prose to restate the table", () => {
    const log = useLog(1000 * MS, method({ text: "A.run", totalNs: 500 * MS }));

    expect(Object.keys(ranked(log))).toEqual([
      "durationTotalMs",
      "returnedSelfPercentage",
      "matchedCount",
      "operations",
    ]);
  });

  it("reports zero share when the log recorded no duration", () => {
    const log = useLog(0, method({ text: "A.run" }));

    const result = ranked(log);

    expect(result.returnedSelfPercentage).toBe(0);
    expect(result.operations[0]?.selfPercentage).toBe(0);
  });

  it("ranks only the event types the caller asked for", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      query({ text: "SELECT Id", totalNs: 400 * MS }),
    );

    expect(
      ranked(log, { type: ["SOQL_EXECUTE_BEGIN"] }).operations,
    ).toEqual([expect.objectContaining({ name: "SELECT Id" })]);
  });

  // The category is what the type cannot say and the type is what the category
  // cannot: a `database` filter takes the query and the DML together, where a
  // type filter would have to name both.
  it("ranks only the categories the caller asked for", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      query({ text: "SELECT Id", totalNs: 400 * MS }),
      {
        type: "DML_BEGIN",
        category: "DML",
        debugCategory: "database",
        text: "DML Insert Account",
        totalNs: 300 * MS,
      },
    );

    expect(
      ranked(log, { debugCategory: ["database"] }).operations.map(
        (o) => o.name,
      ),
    ).toEqual(["SELECT Id", "DML Insert Account"]);
  });

  it("ranks only the namespaces the caller asked for", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", namespace: "Custom", totalNs: 400 * MS }),
    );

    expect(
      ranked(log, { namespace: ["Custom"] }).operations,
    ).toEqual([expect.objectContaining({ name: "B.run" })]);
  });

  it("drops an operation below the caller's self time", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 100 * MS }),
    );

    expect(
      ranked(log, { minSelfMs: 300 }).operations.map((o) => o.name),
    ).toEqual(["A.run"]);
  });

  it("drops an operation whose timestamps did not parse to a number", () => {
    const log = useLog(1000 * MS, method({ text: "A.run", totalNs: NaN }));

    expect(ranked(log, { minSelfMs: 0 }).operations).toEqual([]);
  });

  it("returns at most the rows the caller asked for", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 400 * MS }),
    );

    expect(ranked(log, { limit: 1 }).operations).toHaveLength(1);
  });

  it("pages the ranking from offset, so a caller can walk past the first page", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 400 * MS }),
      method({ text: "C.run", totalNs: 300 * MS }),
    );

    const result = ranked(log, { limit: 1, offset: 1 });

    expect(result.operations.map((row) => row.name)).toEqual(["B.run"]);
    // The rows behind the page are still counted, or a caller cannot tell it
    // has reached the end.
    expect(result.matchedCount).toBe(3);
    expect(result.nextOffset).toBe(2);
  });

  it("gives no nextOffset on the last page", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 400 * MS }),
      method({ text: "C.run", totalNs: 300 * MS }),
    );

    expect(ranked(log, { limit: 1, offset: 2 }).nextOffset).toBeUndefined();
  });

  // `slice(0, -5)` drops the five fastest rows and returns all the rest, so a
  // page of ten becomes the whole ranking and no caller can detect it;
  // `slice(0, 3.7)` is a whole-number cut spelled as a fraction. The schema is
  // where both stop.
  it.each([
    ["negative", -5],
    ["fractional", 3.7],
  ])("refuses a %s limit or offset", (_name, value) => {
    expect(listSlowOperationsTool.config.inputSchema.shape.limit.safeParse(value).success).toBe(
      false,
    );
    expect(listSlowOperationsTool.config.inputSchema.shape.offset.safeParse(value).success).toBe(
      false,
    );
  });

  it("keeps the head and the tail of an over-long name", () => {
    const columns = "SELECT ".concat("a__c, ".repeat(200));
    const log = useLog(
      1000 * MS,
      query({ text: `${columns}FROM Account`, totalNs: 500 * MS }),
    );

    const name = ranked(log).operations[0]!.name;

    // A query names its columns first and its object last, so both ends have to
    // survive or the row cannot be identified.
    expect(name.startsWith("SELECT a__c,")).toBe(true);
    expect(name.endsWith("FROM Account")).toBe(true);
    expect(name).toHaveLength(400);
  });

  it("returns fewer rows than asked when the page would be too large", () => {
    // 400 characters of name each after eliding, so the 60,000-character budget
    // runs out well before the 200th row.
    const log = useLog(
      1000 * MS,
      ...Array.from({ length: 200 }, (_, index) =>
        method({
          text: `M${index}.`.padEnd(600, "x"),
          totalNs: (200 - index) * MS,
        }),
      ),
    );

    const result = ranked(log, { limit: 200 });

    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.operations.length).toBeLessThan(200);
    // Rows returned read against rows matched is what says the page was cut.
    expect(result.matchedCount).toBe(200);
    expect(result.nextOffset).toBe(result.operations.length);
  });

  it("spends the same budget on the plans behind a namespace row", () => {
    // A namespace row names the namespace, so every plan under it carries its
    // own query text. Left outside the budget the table grew without limit: on
    // one real log 30 such plans were 90% of the response.
    const log = useLog(
      1000 * MS,
      ...Array.from({ length: 200 }, (_, index) =>
        explainedQuery(
          {
            text: `SELECT f${index},`.padEnd(600, "x"),
            namespace: "Custom",
            totalNs: (200 - index) * MS,
          },
          {},
        ),
      ),
    );

    const result = ranked(log, { groupBy: "namespace", limit: 200 });

    expect(result.queryPlans?.length).toBeGreaterThan(0);
    expect(result.queryPlans?.length).toBeLessThan(200);
    expect(cost([...result.operations, ...(result.queryPlans ?? [])])).
      toBeLessThanOrEqual(60_000);
  });

  it("returns ten rows when the caller sets no limit", () => {
    const log = useLog(
      1000 * MS,
      ...Array.from({ length: 12 }, (_, index) =>
        method({ text: `M${index}`, totalNs: (index + 1) * MS }),
      ),
    );

    expect(ranked(log).operations).toHaveLength(10);
  });

  it("folds a repeated query into one row before the self time drops it", () => {
    const repeat = () => query({ text: "SELECT Id", totalNs: 100 * MS });
    const log = useLog(1000 * MS, repeat(), repeat(), repeat());

    expect(
      ranked(log, { groupBy: "name", minSelfMs: 250 }).operations,
    ).toEqual([
      expect.objectContaining({
        name: "SELECT Id",
        callCount: 3,
        durationSelfMs: 300,
        soqlCount: 3,
      }),
    ]);
  });

  describe("query plans", () => {
    // The whole point of the key: the plan has to name the row that carries the
    // query, not the first row of the table.
    it("points at the ranked row the query is on", () => {
      const log = useLog(
        1000 * MS,
        method({ text: "A.run", totalNs: 500 * MS }),
        explainedQuery({ text: "SELECT Id", totalNs: 300 * MS }, {}),
      );

      const result = ranked(log);

      expect(result.operations[1]?.name).toBe("SELECT Id");
      expect(result.queryPlans?.[0]).toEqual(
        expect.objectContaining({ operationRow: 2 }),
      );
    });

    it("reports what the optimiser decided about a ranked query", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 500 * MS }, {}),
      );

      expect(ranked(log).queryPlans).toEqual([
        {
          operationRow: 1,
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
          cardinality: 100,
          sObjectCardinality: 1000,
        },
      ]);
    });

    // Both orders, so keeping the first or the last plan cannot pass for keeping the worst.
    it.each([
      ["first", false],
      ["last", true],
    ])("keeps the worst plan when one query was explained more than once, the worst %s", (_name, worstLast) => {
      const cheap = explainedQuery({ text: "SELECT Id", totalNs: 100 * MS }, {
        leadingOperationType: "Index",
        relativeCost: 0.5,
      });
      const worst = explainedQuery({ text: "SELECT Id", totalNs: 100 * MS }, {});
      const log = useLog(1000 * MS, ...(worstLast ? [cheap, worst] : [worst, cheap]));

      expect(ranked(log).queryPlans).toEqual([
        expect.objectContaining({
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
        }),
      ]);
    });

    // A filter narrows the rows, not the plans: the worst plan for a text is the one to act on.
    it("keeps the worst plan of a query the filter left out of the rows", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", namespace: "A", totalNs: 100 * MS }, {
          leadingOperationType: "Index",
          relativeCost: 0.5,
        }),
        explainedQuery({ text: "SELECT Id", namespace: "B", totalNs: 100 * MS }, {}),
      );

      expect(ranked(log, { namespace: ["A"] }).queryPlans).toEqual([
        expect.objectContaining({
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
        }),
      ]);
    });

    it("explains only the queries the row cap returned", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 500 * MS }, {}),
        explainedQuery({ text: "SELECT Name", totalNs: 100 * MS }, {}),
      );

      const result = ranked(log, { limit: 1 });

      expect(result.operations.map((row) => row.name)).toEqual(["SELECT Id"]);
      expect(result.queryPlans).toHaveLength(1);
    });

    it("reports no table when the log explained none of those queries", () => {
      const log = useLog(1000 * MS, query({ text: "SELECT Id", totalNs: 500 * MS }));

      expect(ranked(log)).not.toHaveProperty("queryPlans");
    });

    // One plan per ranked row, not per query text. The row is the only thing
    // naming the query now, so stating the verdict once would leave the second
    // call of the same query reading as though nothing was explained about it.
    it("states a plan against every ranked row that carries the query", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 300 * MS }, {}),
        explainedQuery({ text: "SELECT Id", totalNs: 200 * MS }, {}),
      );

      expect(
        ranked(log, { groupBy: "none" }).queryPlans?.map((plan) =>
          "operationRow" in plan ? plan.operationRow : plan.name,
        ),
      ).toEqual([1, 2]);
    });

    // Grouping by namespace names the row after the namespace, so the query
    // text is nowhere else in the response and the plan has to carry it.
    it("explains the queries behind a row grouped by namespace", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery(
          { text: "SELECT Id", namespace: "Custom", totalNs: 500 * MS },
          {},
        ),
      );

      expect(
        ranked(log, { groupBy: "namespace" }).queryPlans?.[0],
      ).toEqual(expect.objectContaining({ name: "SELECT Id" }));
    });

    // The mistake: explaining every selected query, not only those behind the
    // namespace rows returned, so a plan names a query no row stands for.
    it("explains only the queries behind the namespace rows returned", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT a", namespace: "First", totalNs: 500 * MS }, {}),
        explainedQuery({ text: "SELECT b", namespace: "Second", totalNs: 100 * MS }, {}),
      );

      expect(
        ranked(log, { groupBy: "namespace", limit: 1 }).queryPlans?.map((plan) => plan.name),
      ).toEqual(["SELECT a"]);
    });

    // Ungrouped, a row is one call, so it must be told that call's own plan.
    // The worst-per-text plan is the figure to act on for a group, but here it
    // would state a cost the optimiser never reached for the row.
    it("states each call's own plan when every row is one call", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 300 * MS }, {
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
        }),
        explainedQuery({ text: "SELECT Id", totalNs: 200 * MS }, {
          leadingOperationType: "Index",
          relativeCost: 0.5,
        }),
      );

      expect(
        ranked(log, { groupBy: "none" }).queryPlans,
      ).toEqual([
        expect.objectContaining({
          operationRow: 1,
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
        }),
        expect.objectContaining({
          operationRow: 2,
          leadingOperationType: "Index",
          relativeCost: 0.5,
        }),
      ]);
    });

    it("drops a plan the log did not record in full", () => {
      const log = useLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 500 * MS }, {
          relativeCost: null,
        }),
      );

      expect(ranked(log)).not.toHaveProperty("queryPlans");
    });
  });

  const cheap = () => method({ text: "A.run", totalNs: 30 * MS });

  it("groups by name unless the caller says otherwise, so volume surfaces", () => {
    const log = useLog(
      1000 * MS,
      ...Array.from({ length: 20 }, cheap),
      method({ text: "B.run", totalNs: 100 * MS }),
    );

    expect(ranked(log).operations[0]).toMatchObject({
      name: "A.run",
      callCount: 20,
      durationSelfMs: 600,
    });
  });

  it("ranks each call on its own when the caller passes none", () => {
    const log = useLog(1000 * MS, cheap(), cheap());

    const operations = ranked(log, { groupBy: "none" }).operations;

    expect(operations).toHaveLength(2);
    // The row is one call, so its slowest call is the row itself.
    expect(operations[0]).not.toHaveProperty("durationSelfMaxMs");
  });

  it("separates one bad call from sheer volume in durationSelfMaxMs", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "Outlier", totalNs: 490 * MS }),
      method({ text: "Outlier", totalNs: 10 * MS }),
      ...Array.from({ length: 10 }, () =>
        method({ text: "Volume", totalNs: 40 * MS }),
      ),
    );

    expect(
      ranked(log).operations.map((o) => [
        o.name,
        o.durationSelfMs,
        o.durationSelfMaxMs,
      ]),
    ).toEqual([
      ["Outlier", 500, 490],
      ["Volume", 400, 40],
    ]);
  });

  it("reports what a group costs, counting a nested call once", () => {
    const log = useLog(
      1000 * MS,
      method({
        text: "Outer",
        totalNs: 500 * MS,
        selfNs: 100 * MS,
        children: [method({ text: "Inner", totalNs: 400 * MS })],
      }),
    );

    expect(
      ranked(log, { groupBy: "namespace" }).operations,
    ).toEqual([
      expect.objectContaining({
        name: "default",
        callCount: 2,
        durationTotalMs: 500,
      }),
    ]);
  });

  it("keeps the summed self time of grouped rows within the transaction", () => {
    const log = useLog(
      1000 * MS,
      method({
        text: "Outer",
        totalNs: 900 * MS,
        selfNs: 200 * MS,
        children: [
          method({ text: "Inner", totalNs: 700 * MS, selfNs: 700 * MS }),
        ],
      }),
    );

    const result = ranked(log, { groupBy: "namespace" });
    const summed = result.operations.reduce(
      (total, operation) => total + operation.durationSelfMs,
      0,
    );

    expect(summed).toBeLessThanOrEqual(result.durationTotalMs);
  });

  it("groups by namespace, and names each row after it", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", namespace: "Custom", totalNs: 300 * MS }),
      method({ text: "B.run", namespace: "Custom", totalNs: 200 * MS }),
    );

    expect(
      ranked(log, { groupBy: "namespace" }).operations,
    ).toEqual([
      expect.objectContaining({ name: "Custom", callCount: 2 }),
    ]);
  });

  it("attributes platform DML to the package that drove it", () => {
    const log = useLog(
      1000 * MS,
      method({
        text: "Custom.run",
        namespace: "Custom",
        totalNs: 500 * MS,
        selfNs: 100 * MS,
        children: [
          {
            type: "DML_BEGIN",
            category: "DML",
            text: "DML Insert Account",
            namespace: "default",
            totalNs: 400 * MS,
          },
        ],
      }),
    );

    const operations = ranked(log, { groupBy: "callerNamespace" })
      .operations;

    expect(operations).toContainEqual(
      expect.objectContaining({
        type: "DML_BEGIN",
        name: "Custom",
        namespace: "Custom",
        durationSelfMs: 400,
      }),
    );
  });

  it("folds a namespace's categories into one row each when asked", () => {
    const log = useLog(
      1000 * MS,
      method({ text: "A.run", namespace: "Custom", totalNs: 300 * MS }),
      method({
        type: "CONSTRUCTOR_ENTRY",
        text: "A.A()",
        namespace: "Custom",
        totalNs: 200 * MS,
      }),
      query({ text: "SELECT Id", namespace: "Custom", totalNs: 100 * MS }),
    );

    const { operations } = ranked(log, {
      groupBy: "debugCategory",
    });

    expect(operations).toEqual([
      {
        debugCategory: "apexCode",
        namespace: "Custom",
        callCount: 2,
        durationTotalMs: 500,
        durationSelfMs: 500,
        durationSelfMaxMs: 300,
        selfPercentage: 50,
        soqlCount: 0,
        dmlCount: 0,
        soslCount: 0,
        rowCount: 0,
        thrownCount: 0,
      },
      expect.objectContaining({
        debugCategory: "database",
        callCount: 1,
        durationSelfMs: 100,
      }),
    ]);
  });

  describe("call sites", () => {
    /** A method that runs `children`, and whose own self time ranks below them. */
    const caller = (text: string, ...children: NodeSpec[]): NodeSpec =>
      method({ text, totalNs: 1 * MS, selfNs: 0, children });

    const sitesOf = (result: SlowOperationsResult, name: string) => {
      const row = result.operations.findIndex((operation) => operation.name === name) + 1;
      return (result.callSites ?? []).filter((site) => site.operationRow === row);
    };

    // The mistake: a site keyed on the caller alone would fold A's two lines,
    // and one keyed on the call would list A twice.
    it("folds calls by name, and lists each caller and line they came from", () => {
      const log = useLog(
        1000 * MS,
        caller(
          "A.run()",
          query({ text: "SELECT Id", lineNumber: 10, totalNs: 20 * MS }),
          query({ text: "SELECT Id", lineNumber: 10, totalNs: 20 * MS }),
          query({ text: "SELECT Id", lineNumber: 11, totalNs: 5 * MS }),
        ),
        caller("B.run()", query({ text: "SELECT Id", lineNumber: 20, totalNs: 50 * MS })),
      );

      const result = ranked(log, { groupBy: "callSite" });

      expect(result.operations[0]).toMatchObject({
        name: "SELECT Id",
        callCount: 4,
        callSiteCount: 3,
      });
      expect(sitesOf(result, "SELECT Id")).toEqual([
        { operationRow: 1, caller: "B.run()", lineNumber: 20, callCount: 1, durationSelfMs: 50 },
        { operationRow: 1, caller: "A.run()", lineNumber: 10, callCount: 2, durationSelfMs: 40 },
        { operationRow: 1, caller: "A.run()", lineNumber: 11, callCount: 1, durationSelfMs: 5 },
      ]);
    });

    it("lists the five costliest sites, and counts every one", () => {
      const log = useLog(
        1000 * MS,
        ...[1, 2, 3, 4, 5, 6].map((index) =>
          caller(`C${index}.run()`, query({ text: "SELECT Id", lineNumber: 1, totalNs: index * MS })),
        ),
      );

      const result = ranked(log, { groupBy: "callSite" });

      expect(result.operations[0]?.callSiteCount).toBe(6);
      expect(sitesOf(result, "SELECT Id").map((site) => site.caller)).toEqual([
        "C6.run()",
        "C5.run()",
        "C4.run()",
        "C3.run()",
        "C2.run()",
      ]);
    });

    // Managed code hides its line as EXTERNAL; the caller is still known, and
    // "hidden" must not read as "the log has no line".
    it("tells a line managed code hid from one the log does not have", () => {
      const log = useLog(
        1000 * MS,
        caller("pkg.Api.run()", query({ text: "SELECT Id", lineNumber: "EXTERNAL", totalNs: 50 * MS })),
        caller("B.run()", query({ text: "SELECT Id", totalNs: 10 * MS })),
      );

      expect(
        sitesOf(ranked(log, { groupBy: "callSite" }), "SELECT Id").map(
          ({ caller, lineNumber }) => [caller, lineNumber],
        ),
      ).toEqual([
        ["pkg.Api.run()", "EXTERNAL"],
        ["B.run()", null],
      ]);
    });

    // The line counts in the code frame it was read in. Under any other parent
    // that frame is not in the tree, so a line beside that parent's name would
    // point into code it does not belong to.
    it("states neither caller nor line where no code frame made the call", () => {
      const log = useLog(
        1000 * MS,
        query({ text: "SELECT Id", lineNumber: 7, totalNs: 50 * MS }),
      );

      expect(sitesOf(ranked(log, { groupBy: "callSite" }), "SELECT Id")).toEqual([
        { operationRow: 1, caller: null, lineNumber: null, callCount: 1, durationSelfMs: 50 },
      ]);
    });

    it("orders the sites by heap, and states it, under the heap ranking", () => {
      const log = useLog(
        1000 * MS,
        caller("Slow.run()", method({ text: "Work.do()", lineNumber: 1, totalNs: 50 * MS })),
        caller(
          "Holds.run()",
          method({ text: "Work.do()", lineNumber: 2, totalNs: 5 * MS, heapSelfNetBytes: 900_000 }),
        ),
      );

      const sites = sitesOf(
        ranked(log, { groupBy: "callSite", sortBy: "heapSelfNetBytes" }),
        "Work.do()",
      );

      expect(sites.map(({ caller, heapSelfNetBytes }) => [caller, heapSelfNetBytes])).toEqual([
        ["Holds.run()", 900_000],
        ["Slow.run()", 0],
      ]);
    });

    it("adds neither the table nor the column under any other grouping", () => {
      const log = useLog(
        1000 * MS,
        caller("A.run()", query({ text: "SELECT Id", lineNumber: 1, totalNs: 50 * MS })),
      );

      const result = ranked(log);

      expect(result).not.toHaveProperty("callSites");
      expect(result.operations[0]).not.toHaveProperty("callSiteCount");
    });

    // An absent table would read as "not asked"; empty says nothing matched.
    it("reports the table even when no row matched", () => {
      expect(ranked(useLog(1000 * MS), { groupBy: "callSite" }).callSites).toEqual([]);
    });

    it("spends what the rows and plans left of the page budget on the sites", () => {
      // 100 explained queries, each called from five callers whose names elide
      // to 400 characters: 500 sites, far past the 60,000-character budget.
      const log = useLog(
        1000 * MS,
        ...Array.from({ length: 100 }, (_, row) =>
          Array.from({ length: 5 }, (_, site) =>
            caller(
              `C${row}_${site}.`.padEnd(600, "x"),
              explainedQuery(
                { text: `SELECT f${row}`, lineNumber: 1, totalNs: (200 - row) * MS },
                {},
              ),
            ),
          ),
        ).flat(),
      );

      const result = ranked(log, {
        groupBy: "callSite",
        type: ["SOQL_EXECUTE_BEGIN"],
        limit: 100,
      });

      expect(result.operations).toHaveLength(100);
      expect(result.callSites?.length).toBeGreaterThan(0);
      expect(result.queryPlans?.length).toBeGreaterThan(0);
      expect(result.callSites?.length).toBeLessThan(500);
      expect(
        cost([
          ...result.operations,
          ...(result.queryPlans ?? []),
          ...(result.callSites ?? []),
        ]),
      ).toBeLessThanOrEqual(60_000);
    });

    // A constructor or a trigger's code unit runs code, and its lines count in it.
    it.each(["CONSTRUCTOR_ENTRY", "CODE_UNIT_STARTED"])(
      "names a %s frame as the caller",
      (type) => {
        const log = useLog(
          1000 * MS,
          method({
            type,
            text: "Account.trigger",
            totalNs: 1 * MS,
            selfNs: 0,
            children: [query({ text: "SELECT Id", lineNumber: 4, totalNs: 50 * MS })],
          }),
        );

        expect(
          sitesOf(ranked(log, { groupBy: "callSite" }), "SELECT Id").map(
            ({ caller, lineNumber }) => [caller, lineNumber],
          ),
        ).toEqual([["Account.trigger", 4]]);
      },
    );

    it("keeps the head and the tail of an over-long caller", () => {
      const log = useLog(
        1000 * MS,
        caller(
          "Long.".padEnd(600, "x") + ".run()",
          query({ text: "SELECT Id", lineNumber: 1, totalNs: 50 * MS }),
        ),
      );

      const [site] = sitesOf(ranked(log, { groupBy: "callSite" }), "SELECT Id");

      expect(site?.caller).toHaveLength(400);
      expect(site?.caller?.startsWith("Long.")).toBe(true);
      expect(site?.caller?.endsWith(".run()")).toBe(true);
    });

    // A plan's operationRow counts the rows returned, not the ranking, and a
    // site must count the same way or it names the wrong row on page two.
    it("points a site at the row on the page it was returned on", () => {
      const log = useLog(
        1000 * MS,
        caller("A.run()", query({ text: "SELECT a", lineNumber: 1, totalNs: 50 * MS })),
        caller("B.run()", query({ text: "SELECT b", lineNumber: 2, totalNs: 20 * MS })),
      );

      const result = ranked(log, {
        groupBy: "callSite",
        type: ["SOQL_EXECUTE_BEGIN"],
        offset: 1,
      });

      expect(result.operations.map((row) => row.name)).toEqual(["SELECT b"]);
      expect(result.callSites).toEqual([
        { operationRow: 1, caller: "B.run()", lineNumber: 2, callCount: 1, durationSelfMs: 20 },
      ]);
    });
  });

  describe("heap ranking", () => {
    // The fact the whole option rests on: gross churn cannot tell these two
    // apart, and self time ranks them by how long they took instead.
    const holds = () =>
      method({ text: "Holds", totalNs: 10 * MS, heapSelfNetBytes: 900_000 });
    const frees = () =>
      method({ text: "Frees", totalNs: 500 * MS, heapSelfNetBytes: 0 });

    it("ranks the code that retained the heap above the code that freed it", () => {
      const log = useLog(1000 * MS, frees(), holds());

      const result = ranked(log, { sortBy: "heapSelfNetBytes" });

      expect(result.operations.map((row) => row.name)).toEqual([
        "Holds",
        "Frees",
      ]);
      expect(result.operations[0]?.heapSelfNetBytes).toBe(900_000);
    });

    it("leaves the default ranking as it was, column and all", () => {
      const log = useLog(1000 * MS, frees(), holds());

      const rows = ranked(log).operations;

      expect(rows.map((row) => row.name)).toEqual(["Frees", "Holds"]);
      expect(rows[0]).not.toHaveProperty("heapSelfNetBytes");
    });

    // Most logs record no allocation, so every row is a flat zero and the sort
    // key decides nothing. Falling back to self time answers the question the
    // caller could have asked, rather than the log's own order.
    it("falls back to self time when nothing allocated", () => {
      // Stated fastest first, so the log's own order is not the answer and a
      // sort with no second key could not produce it.
      const log = useLog(
        1000 * MS,
        method({ text: "Fast", totalNs: 100 * MS }),
        method({ text: "Slow", totalNs: 500 * MS }),
      );

      const result = ranked(log, { sortBy: "heapSelfNetBytes" });

      expect(result.operations.map((row) => row.name)).toEqual([
        "Slow",
        "Fast",
      ]);
      expect(result.operations[0]?.heapSelfNetBytes).toBe(0);
    });

    it("reports a body that freed more than it allocated below zero", () => {
      const log = useLog(1000 * MS, method({ text: "Frees", heapSelfNetBytes: -400 }));

      expect(
        ranked(log, { sortBy: "heapSelfNetBytes" }).operations[0]
          ?.heapSelfNetBytes,
      ).toBe(-400);
    });

    // The one thing the rows cannot say: whether the page holds the heap that
    // matters. A default page misses more than a tenth of it on 17 of the 40
    // real logs that allocate.
    it("says what share of the transaction's heap the returned rows carry", () => {
      const log = useLog(
        1000 * MS,
        method({ text: "Holds", heapSelfNetBytes: 750 }),
        method({ text: "Some", heapSelfNetBytes: 250 }),
      );

      const result = ranked(log, {
        sortBy: "heapSelfNetBytes",
        limit: 1,
      });

      expect(result.returnedHeapPercentage).toBe(75);
      // Read against the share, this is what says rows were held back.
      expect(result.matchedCount).toBe(2);
    });

    it("reports a zero share when the log retained no heap", () => {
      const log = useLog(1000 * MS, method({ text: "A.run", totalNs: 500 * MS }));

      expect(
        ranked(log, { sortBy: "heapSelfNetBytes" })
          .returnedHeapPercentage,
      ).toBe(0);
    });
  });
});
