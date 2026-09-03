/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  omitEmpty,
  roundMs,
  roundPercent,
  toLimitRows,
  toNamespaceLimitRows,
} from "../src/tools/responseShaping";
import {
  ALL_LIMIT_METRICS,
  type Limits,
  type NamespaceLimits,
} from "@apexdevtools/apex-log-parser/types";

describe("responseShaping", () => {
  describe("roundMs", () => {
    it("should keep microsecond resolution", () => {
      expect(roundMs(1.2345678)).toBe(1.235);
      expect(roundMs(0.0004)).toBe(0);
    });

    it("should drop the float noise that division introduces", () => {
      expect(roundMs(1234567 / 1_000_000)).toBe(1.235);
      expect(roundMs(0.1 + 0.2)).toBe(0.3);
    });

    it("should leave whole numbers alone", () => {
      expect(roundMs(500)).toBe(500);
      expect(roundMs(0)).toBe(0);
    });
  });

  describe("roundPercent", () => {
    it("should round to one decimal place", () => {
      expect(roundPercent(93.333333)).toBe(93.3);
      expect(roundPercent(85)).toBe(85);
      expect(roundPercent(0.04)).toBe(0);
    });
  });

  describe("omitEmpty", () => {
    it("should drop the lists nothing was added to and keep the rest", () => {
      expect(
        omitEmpty({
          logIssues: [{ type: "error" }],
          recommendations: [],
          parsingErrors: [],
        }),
      ).toEqual({ logIssues: [{ type: "error" }] });
    });

    it("should return an empty object when every list is empty", () => {
      expect(omitEmpty({ logIssues: [], recommendations: [] })).toEqual({});
    });
  });

  // From the parser, so the set and its order cannot drift from what the tools
  // emit. `tests/parserContract.test.ts` pins the list itself.
  const limitNames = ALL_LIMIT_METRICS.map((metric) => metric.key);

  const limitsOf = (
    used: Partial<Record<keyof Limits, number>> = {},
  ): Limits =>
    Object.fromEntries(
      limitNames.map((name) => [
        name,
        { used: used[name] ?? 0, limit: 100, percentUsed: null },
      ]),
    ) as Limits;

  const namespaceLimitsOf = (
    used: Partial<Record<keyof Limits, number>> = {},
    peakUsed = used,
  ): NamespaceLimits => ({ final: limitsOf(used), peak: limitsOf(peakUsed) });

  describe("toLimitRows", () => {
    it("should return one row per limit in parser order", () => {
      const rows = toLimitRows(limitsOf());

      expect(rows).toHaveLength(limitNames.length);
      expect(rows.map((row) => row.limit)).toEqual(limitNames);
    });

    it("should keep a limit nothing was spent against", () => {
      // "How many DML statements were consumed?" has to be answerable with
      // "none". An absent row cannot say that.
      const rows = toLimitRows(limitsOf({ cpuTime: 15163 }));

      expect(rows).toContainEqual({
        limit: "dmlStatements",
        used: 0,
        max: 100,
      });
      expect(rows).toContainEqual({ limit: "cpuTime", used: 15163, max: 100 });
    });
  });

  describe("toNamespaceLimitRows", () => {
    it("should report one row per limit a namespace consumed", () => {
      const rows = toNamespaceLimitRows(
        new Map([
          ["srm_pkg", namespaceLimitsOf({ soqlQueries: 4, cpuTime: 900 })],
          ["default", namespaceLimitsOf({ dmlStatements: 2 })],
        ]),
      );

      expect(rows).toEqual([
        { namespace: "srm_pkg", limit: "soqlQueries", used: 4 },
        { namespace: "srm_pkg", limit: "cpuTime", used: 900 },
        { namespace: "default", limit: "dmlStatements", used: 2 },
      ]);
    });

    it("should drop the limits a namespace did not consume", () => {
      // A row here is an occurrence. Whether a limit was measured at all is a
      // property of the transaction, and the whole-log table answers that.
      const rows = toNamespaceLimitRows(
        new Map([["srm_pkg", namespaceLimitsOf({ cpuTime: 900 })]]),
      );

      expect(rows).toEqual([
        { namespace: "srm_pkg", limit: "cpuTime", used: 900 },
      ]);
    });

    it("should not repeat the ceiling, which belongs to the transaction", () => {
      const [row] = toNamespaceLimitRows(
        new Map([["srm_pkg", namespaceLimitsOf({ cpuTime: 900 })]]),
      );

      expect(row).not.toHaveProperty("max");
    });

    it("should report the peak a namespace reached, not where it ended", () => {
      // The whole-log table above these rows states the peak, so a row that
      // stated the final figure would contradict it.
      const rows = toNamespaceLimitRows(
        new Map([
          ["srm_pkg", namespaceLimitsOf({ soqlQueries: 1 }, { soqlQueries: 6 })],
        ]),
      );

      expect(rows).toEqual([
        { namespace: "srm_pkg", limit: "soqlQueries", used: 6 },
      ]);
    });

    it("should return no rows when the log named no namespace", () => {
      expect(toNamespaceLimitRows(new Map())).toEqual([]);
    });
  });
});
