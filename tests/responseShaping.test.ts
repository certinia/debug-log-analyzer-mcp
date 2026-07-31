/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  isEmptyValue,
  omitEmpty,
  roundMs,
  roundPercent,
  toLimitRows,
} from "../src/tools/responseShaping";
import type { GovernorLimits, Limits } from "../src/ApexLogParser";

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

  describe("isEmptyValue", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["zero", 0],
      ["the empty string", ""],
      ["an empty array", []],
      ["an empty object", {}],
    ])("should treat %s as empty", (_label, value) => {
      expect(isEmptyValue(value)).toBe(true);
    });

    it.each([
      ["a non-zero number", 1],
      ["a negative number", -1],
      ["a non-empty string", "default"],
      ["a populated array", [0]],
      ["a populated object", { used: 0 }],
    ])("should treat %s as carrying information", (_label, value) => {
      expect(isEmptyValue(value)).toBe(false);
    });

    it("should treat false as an answer rather than an absence", () => {
      // A zero count and an absent count mean the same thing; `success: false` and
      // an absent `success` do not.
      expect(isEmptyValue(false)).toBe(false);
    });
  });

  describe("omitEmpty", () => {
    it("should drop only the keys that carry no information", () => {
      expect(
        omitEmpty({
          totalMethods: 3,
          totalSOQLQueries: 0,
          namespaces: [],
          governorLimits: {},
          note: "",
          parsingErrors: null,
          success: false,
        }),
      ).toEqual({ totalMethods: 3, success: false });
    });

    it("should return an empty object when nothing survives", () => {
      expect(omitEmpty({ a: 0, b: [] })).toEqual({});
    });
  });

  describe("toLimitRows", () => {
    const limitNames: (keyof Limits)[] = [
      "soqlQueries",
      "soslQueries",
      "queryRows",
      "dmlStatements",
      "publishImmediateDml",
      "dmlRows",
      "cpuTime",
      "heapSize",
      "callouts",
      "emailInvocations",
      "futureCalls",
      "queueableJobsAddedToQueue",
      "mobileApexPushCalls",
    ];

    const buildLimits = (
      used: Partial<Record<keyof Limits, number>> = {},
    ): GovernorLimits =>
      ({
        ...Object.fromEntries(
          limitNames.map((name) => [
            name,
            { used: used[name] ?? 0, limit: 100 },
          ]),
        ),
        byNamespace: new Map(),
      }) as GovernorLimits;

    it("should return one row per limit in parser order", () => {
      const rows = toLimitRows(buildLimits());

      expect(rows).toHaveLength(limitNames.length);
      expect(rows.map((row) => row.name)).toEqual(limitNames);
    });

    it("should keep a limit nothing was spent against", () => {
      // "How many DML statements were consumed?" has to be answerable with
      // "none". An absent row cannot say that.
      const rows = toLimitRows(buildLimits({ cpuTime: 15163 }));

      expect(rows).toContainEqual({
        name: "dmlStatements",
        used: 0,
        limit: 100,
      });
      expect(rows).toContainEqual({ name: "cpuTime", used: 15163, limit: 100 });
    });

    it("should skip byNamespace, which is not a limit", () => {
      expect(toLimitRows(buildLimits()).map((row) => row.name)).not.toContain(
        "byNamespace",
      );
    });
  });
});
