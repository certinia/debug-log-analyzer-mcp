/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";
import { decode } from "@toon-format/toon";

import { clearApexLogCache } from "../src/tools/apexLogSource";
import {
  listSlowOperations,
  listSlowOperationsInputSchema,
  listSlowOperationsToolConfig,
  type SlowOperationsArgs,
  type SlowOperationsResult,
} from "../src/tools/listSlowOperations";
import { parse } from "@apexdevtools/apex-log-parser";
import type { ApexLog } from "@apexdevtools/apex-log-parser";

jest.mock("fs", () => {
  const stat = jest.fn();
  const readFile = jest.fn();
  // A handle is the file at one path, so its stat and read delegate to the
  // mocks above with that path filled in. Tests set and assert on those.
  return {
    promises: {
      stat,
      readFile,
      open: jest.fn(async (path: string) => ({
        stat: (options: unknown) => stat(path, options),
        readFile: (encoding: unknown) => readFile(path, encoding),
        close: jest.fn(),
      })),
    },
  };
});

jest.mock("@apexdevtools/apex-log-parser", () => ({
  parse: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockParse = parse as jest.MockedFunction<typeof parse>;
const mockStats = {
  ino: 1n,
  size: 1n,
  mtimeNs: 1n,
  ctimeNs: 1n,
} as BigIntStats;

const ARGS: SlowOperationsArgs = { logFilePath: "/test/file.log" };
const MS = 1_000_000;

type NodeSpec = {
  type?: string;
  category?: string;
  text?: string | null;
  namespace?: string;
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
  plan?: PlanSpec;
};

/** What a `SOQL_EXECUTE_EXPLAIN` line carries, as the parser leaves it. */
type PlanSpec = {
  leadingOperationType: string | null;
  relativeCost: number | null;
  cardinality: number | null;
  sObjectCardinality: number | null;
};

function node(spec: NodeSpec): unknown {
  const total = spec.totalNs ?? 0;
  const children = (spec.children ?? []).map(node) as { parent?: unknown }[];
  const built = {
    ...spec.plan,
    type: spec.type ?? null,
    ...(spec.category && { category: spec.category }),
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
    children,
  };

  // The parser links every child to its parent, and `callerNamespace` reads it.
  children.forEach((child) => (child.parent = built));

  return built;
}

/** A log whose root is the transaction frame, and which runs `children`. */
function mockLog(totalNs: number, ...children: NodeSpec[]): void {
  mockFs.stat.mockResolvedValue(mockStats);
  mockFs.readFile.mockResolvedValue("log content");
  mockParse.mockReturnValue({
    ...(node({
      type: "EXECUTION_STARTED",
      text: "Root",
      totalNs,
      children,
    }) as ApexLog),
    // A header these cases say nothing about, so no capture level is reported
    // and the assertions below are about the ranking alone. The eval goldens
    // cover the levels, against fixtures that carry a real header.
    debugLevels: {},
  });
}

const method = (spec: NodeSpec): NodeSpec => ({
  type: "METHOD_ENTRY",
  category: "Apex",
  ...spec,
});

const query = (spec: NodeSpec): NodeSpec => ({
  type: "SOQL_EXECUTE_BEGIN",
  category: "SOQL",
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

async function ranked(
  args: SlowOperationsArgs = ARGS,
): Promise<SlowOperationsResult> {
  const result = await listSlowOperations(args);
  return decode(result.content[0]!.text) as SlowOperationsResult;
}

describe("listSlowOperations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The suites reuse one path with different content, which the cache would
    // otherwise hide.
    clearApexLogCache();
  });

  describe("tool configuration", () => {
    it("says it ranks by self time, so a client can select it", () => {
      expect(listSlowOperationsToolConfig.description).toContain(
        "self-execution time",
      );
    });

    it("takes every axis a caller narrows the ranking on", () => {
      expect(Object.keys(listSlowOperationsInputSchema)).toEqual([
        "logFilePath",
        "kind",
        "namespace",
        "minSelfMs",
        "limit",
        "offset",
        "groupBy",
      ]);
    });

    it("annotates only the hints that carry meaning for a read-only tool", () => {
      expect(listSlowOperationsToolConfig.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
    });
  });

  it("ranks a query alongside a method, slowest self time first", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 400 * MS }),
      query({ text: "SELECT Id", totalNs: 500 * MS }),
    );

    expect((await ranked()).operations.map((o) => [o.kind, o.name])).toEqual([
      ["soql", "SELECT Id"],
      ["method", "A.run"],
    ]);
  });

  it("reports durations in milliseconds and the share of the transaction", async () => {
    mockLog(1000 * MS, method({ text: "A.run", totalNs: 500 * MS }));

    await expect(ranked()).resolves.toEqual({
      durationTotalMs: 1000,
      returnedSelfPercentage: 50,
      matchedCount: 1,
      operations: [
        {
          kind: "method",
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

  it("says what share the returned rows account for, not what is missing", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 200 * MS }),
    );

    expect((await ranked({ ...ARGS, limit: 1 })).returnedSelfPercentage).toBe(
      50,
    );
  });

  it("counts what the selection matched, not what the cap returned", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 200 * MS }),
      method({ text: "C.run", totalNs: 100 * MS }),
    );

    const result = await ranked({ ...ARGS, limit: 1 });

    expect(result.matchedCount).toBe(3);
    expect(result.operations).toHaveLength(1);
  });

  it("counts the rows the threshold kept, not the calls behind them", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "A.run", totalNs: 200 * MS }),
      method({ text: "B.run", totalNs: 1 * MS }),
    );

    // Grouped, then filtered: two names, and only one clears the threshold.
    expect((await ranked({ ...ARGS, minSelfMs: 10 })).matchedCount).toBe(1);
  });

  it("returns no prose to restate the table", async () => {
    mockLog(1000 * MS, method({ text: "A.run", totalNs: 500 * MS }));

    expect(Object.keys(await ranked())).toEqual([
      "durationTotalMs",
      "returnedSelfPercentage",
      "matchedCount",
      "operations",
    ]);
  });

  it("reports zero share when the log recorded no duration", async () => {
    mockLog(0, method({ text: "A.run" }));

    const result = await ranked();

    expect(result.returnedSelfPercentage).toBe(0);
    expect(result.operations[0]?.selfPercentage).toBe(0);
  });

  it("ranks only the kind the caller asked for", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      query({ text: "SELECT Id", totalNs: 400 * MS }),
    );

    expect((await ranked({ ...ARGS, kind: "soql" })).operations).toEqual([
      expect.objectContaining({ name: "SELECT Id" }),
    ]);
  });

  it("ranks only the namespace the caller asked for", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", namespace: "Custom", totalNs: 400 * MS }),
    );

    expect(
      (await ranked({ ...ARGS, namespace: "Custom" })).operations,
    ).toEqual([expect.objectContaining({ name: "B.run" })]);
  });

  it("drops an operation below the caller's self time", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 100 * MS }),
    );

    expect(
      (await ranked({ ...ARGS, minSelfMs: 300 })).operations.map((o) => o.name),
    ).toEqual(["A.run"]);
  });

  it("drops an operation whose timestamps did not parse to a number", async () => {
    mockLog(1000 * MS, method({ text: "A.run", totalNs: NaN }));

    expect((await ranked({ ...ARGS, minSelfMs: 0 })).operations).toEqual([]);
  });

  it("returns at most the rows the caller asked for", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 400 * MS }),
    );

    expect((await ranked({ ...ARGS, limit: 1 })).operations).toHaveLength(1);
  });

  it("pages the ranking from offset, so a caller can walk past the first page", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", totalNs: 500 * MS }),
      method({ text: "B.run", totalNs: 400 * MS }),
      method({ text: "C.run", totalNs: 300 * MS }),
    );

    const result = await ranked({ ...ARGS, limit: 1, offset: 1 });

    expect(result.operations.map((row) => row.name)).toEqual(["B.run"]);
    // The rows behind the page are still counted, or a caller cannot tell it
    // has reached the end.
    expect(result.matchedCount).toBe(3);
  });

  // `slice(0, -5)` drops the five fastest rows and returns all the rest, so a
  // page of ten becomes the whole ranking and no caller can detect it;
  // `slice(0, 3.7)` is a whole-number cut spelled as a fraction. The schema is
  // where both stop.
  it.each([
    ["negative", -5],
    ["fractional", 3.7],
  ])("refuses a %s limit or offset", (_name, value) => {
    expect(listSlowOperationsInputSchema.limit.safeParse(value).success).toBe(
      false,
    );
    expect(listSlowOperationsInputSchema.offset.safeParse(value).success).toBe(
      false,
    );
  });

  it("keeps the head and the tail of an over-long name", async () => {
    const columns = "SELECT ".concat("a__c, ".repeat(200));
    mockLog(
      1000 * MS,
      query({ text: `${columns}FROM Account`, totalNs: 500 * MS }),
    );

    const name = (await ranked()).operations[0]!.name;

    // A query names its columns first and its object last, so both ends have to
    // survive or the row cannot be identified.
    expect(name.startsWith("SELECT a__c,")).toBe(true);
    expect(name.endsWith("FROM Account")).toBe(true);
    expect(name).toHaveLength(400);
  });

  it("returns fewer rows than asked when the page would be too large", async () => {
    // 400 characters of name each after eliding, so the 60,000-character budget
    // runs out well before the 200th row.
    mockLog(
      1000 * MS,
      ...Array.from({ length: 200 }, (_, index) =>
        method({
          text: `M${index}.`.padEnd(600, "x"),
          totalNs: (200 - index) * MS,
        }),
      ),
    );

    const result = await ranked({ ...ARGS, limit: 200 });

    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.operations.length).toBeLessThan(200);
    // Rows returned read against rows matched is what says the page was cut.
    expect(result.matchedCount).toBe(200);
  });

  it("spends the same budget on the plans behind a namespace row", async () => {
    // A namespace row names the namespace, so every plan under it carries its
    // own query text. Left outside the budget the table grew without limit: on
    // one real log 30 such plans were 90% of the response.
    mockLog(
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

    const result = await ranked({ ...ARGS, groupBy: "namespace", limit: 200 });
    const cost = (rows: object[]) =>
      rows.reduce(
        (total, row) =>
          total +
          Object.values(row).reduce(
            (cells, cell) => cells + String(cell).length + 1,
            0,
          ),
        0,
      );

    expect(result.queryPlans?.length).toBeGreaterThan(0);
    expect(result.queryPlans?.length).toBeLessThan(200);
    expect(cost([...result.operations, ...(result.queryPlans ?? [])])).
      toBeLessThanOrEqual(60_000);
  });

  it("returns ten rows when the caller sets no limit", async () => {
    mockLog(
      1000 * MS,
      ...Array.from({ length: 12 }, (_, index) =>
        method({ text: `M${index}`, totalNs: (index + 1) * MS }),
      ),
    );

    expect((await ranked()).operations).toHaveLength(10);
  });

  it("folds a repeated query into one row before the self time drops it", async () => {
    const repeat = () => query({ text: "SELECT Id", totalNs: 100 * MS });
    mockLog(1000 * MS, repeat(), repeat(), repeat());

    expect(
      (await ranked({ ...ARGS, groupBy: "name", minSelfMs: 250 })).operations,
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
    it("points at the ranked row the query is on", async () => {
      mockLog(
        1000 * MS,
        method({ text: "A.run", totalNs: 500 * MS }),
        explainedQuery({ text: "SELECT Id", totalNs: 300 * MS }, {}),
      );

      const result = await ranked();

      expect(result.operations[1]?.name).toBe("SELECT Id");
      expect(result.queryPlans?.[0]).toEqual(
        expect.objectContaining({ operationRow: 2 }),
      );
    });

    it("reports what the optimiser decided about a ranked query", async () => {
      mockLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 500 * MS }, {}),
      );

      expect((await ranked()).queryPlans).toEqual([
        {
          operationRow: 1,
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
          cardinality: 100,
          sObjectCardinality: 1000,
        },
      ]);
    });

    it("keeps the worst plan when one query was explained more than once", async () => {
      mockLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 100 * MS }, {
          leadingOperationType: "Index",
          relativeCost: 0.5,
        }),
        explainedQuery({ text: "SELECT Id", totalNs: 100 * MS }, {}),
      );

      expect((await ranked()).queryPlans).toEqual([
        expect.objectContaining({
          leadingOperationType: "TableScan",
          relativeCost: 2.5,
        }),
      ]);
    });

    it("explains only the queries the row cap returned", async () => {
      mockLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 500 * MS }, {}),
        explainedQuery({ text: "SELECT Name", totalNs: 100 * MS }, {}),
      );

      const result = await ranked({ ...ARGS, limit: 1 });

      expect(result.operations.map((row) => row.name)).toEqual(["SELECT Id"]);
      expect(result.queryPlans).toHaveLength(1);
    });

    it("reports no table when the log explained none of those queries", async () => {
      mockLog(1000 * MS, query({ text: "SELECT Id", totalNs: 500 * MS }));

      expect(await ranked()).not.toHaveProperty("queryPlans");
    });

    // One plan per ranked row, not per query text. The row is the only thing
    // naming the query now, so stating the verdict once would leave the second
    // call of the same query reading as though nothing was explained about it.
    it("states a plan against every ranked row that carries the query", async () => {
      mockLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 300 * MS }, {}),
        explainedQuery({ text: "SELECT Id", totalNs: 200 * MS }, {}),
      );

      expect(
        (await ranked({ ...ARGS, groupBy: "none" })).queryPlans?.map((plan) =>
          "operationRow" in plan ? plan.operationRow : plan.name,
        ),
      ).toEqual([1, 2]);
    });

    // Grouping by namespace names the row after the namespace, so the query
    // text is nowhere else in the response and the plan has to carry it.
    it("explains the queries behind a row grouped by namespace", async () => {
      mockLog(
        1000 * MS,
        explainedQuery(
          { text: "SELECT Id", namespace: "Custom", totalNs: 500 * MS },
          {},
        ),
      );

      expect(
        (await ranked({ ...ARGS, groupBy: "namespace" })).queryPlans?.[0],
      ).toEqual(expect.objectContaining({ name: "SELECT Id" }));
    });

    // Ungrouped, a row is one call, so it must be told that call's own plan.
    // The worst-per-text plan is the figure to act on for a group, but here it
    // would state a cost the optimiser never reached for the row.
    it("states each call's own plan when every row is one call", async () => {
      mockLog(
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
        (await ranked({ ...ARGS, groupBy: "none" })).queryPlans,
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

    it("drops a plan the log did not record in full", async () => {
      mockLog(
        1000 * MS,
        explainedQuery({ text: "SELECT Id", totalNs: 500 * MS }, {
          relativeCost: null,
        }),
      );

      expect(await ranked()).not.toHaveProperty("queryPlans");
    });
  });

  const cheap = () => method({ text: "A.run", totalNs: 30 * MS });

  it("groups by name unless the caller says otherwise, so volume surfaces", async () => {
    mockLog(
      1000 * MS,
      ...Array.from({ length: 20 }, cheap),
      method({ text: "B.run", totalNs: 100 * MS }),
    );

    expect((await ranked()).operations[0]).toMatchObject({
      name: "A.run",
      callCount: 20,
      durationSelfMs: 600,
    });
  });

  it("ranks each call on its own when the caller passes none", async () => {
    mockLog(1000 * MS, cheap(), cheap());

    const operations = (await ranked({ ...ARGS, groupBy: "none" })).operations;

    expect(operations).toHaveLength(2);
    // The row is one call, so its slowest call is the row itself.
    expect(operations[0]).not.toHaveProperty("durationSelfMaxMs");
  });

  it("separates one bad call from sheer volume in durationSelfMaxMs", async () => {
    mockLog(
      1000 * MS,
      method({ text: "Outlier", totalNs: 490 * MS }),
      method({ text: "Outlier", totalNs: 10 * MS }),
      ...Array.from({ length: 10 }, () =>
        method({ text: "Volume", totalNs: 40 * MS }),
      ),
    );

    expect(
      (await ranked()).operations.map((o) => [
        o.name,
        o.durationSelfMs,
        o.durationSelfMaxMs,
      ]),
    ).toEqual([
      ["Outlier", 500, 490],
      ["Volume", 400, 40],
    ]);
  });

  it("reports what a group costs, counting a nested call once", async () => {
    mockLog(
      1000 * MS,
      method({
        text: "Outer",
        totalNs: 500 * MS,
        selfNs: 100 * MS,
        children: [method({ text: "Inner", totalNs: 400 * MS })],
      }),
    );

    expect(
      (await ranked({ ...ARGS, groupBy: "namespace" })).operations,
    ).toEqual([
      expect.objectContaining({
        name: "default",
        callCount: 2,
        durationTotalMs: 500,
      }),
    ]);
  });

  it("keeps the summed self time of grouped rows within the transaction", async () => {
    mockLog(
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

    const result = await ranked({ ...ARGS, groupBy: "namespace" });
    const summed = result.operations.reduce(
      (total, operation) => total + operation.durationSelfMs,
      0,
    );

    expect(summed).toBeLessThanOrEqual(result.durationTotalMs);
  });

  it("groups by namespace, and names each row after it", async () => {
    mockLog(
      1000 * MS,
      method({ text: "A.run", namespace: "Custom", totalNs: 300 * MS }),
      method({ text: "B.run", namespace: "Custom", totalNs: 200 * MS }),
    );

    expect(
      (await ranked({ ...ARGS, groupBy: "namespace" })).operations,
    ).toEqual([
      expect.objectContaining({ name: "Custom", callCount: 2 }),
    ]);
  });

  it("attributes platform DML to the package that drove it", async () => {
    mockLog(
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

    const operations = (await ranked({ ...ARGS, groupBy: "callerNamespace" }))
      .operations;

    expect(operations).toContainEqual(
      expect.objectContaining({
        kind: "dml",
        name: "Custom",
        namespace: "Custom",
        durationSelfMs: 400,
      }),
    );
  });

  it("names the real cause when the log cannot be read", async () => {
    mockFs.stat.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await expect(
      listSlowOperations({ logFilePath: "/nonexistent/file.log" }),
    ).rejects.toThrow("Log file not found: /nonexistent/file.log");
  });
});
