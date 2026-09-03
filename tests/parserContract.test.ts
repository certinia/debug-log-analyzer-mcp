/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What this server assumes about `@apexdevtools/apex-log-parser`.
 *
 * Every other suite works on hand-built nodes, so none of them would notice a
 * parser upgrade that changed one of these. Each case here is an assumption a
 * tool would silently misreport without, pinned against a real parse.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "@apexdevtools/apex-log-parser";
import type { LogEvent } from "@apexdevtools/apex-log-parser";
import {
  ALL_LIMIT_METRICS,
  LOG_LEVEL,
} from "@apexdevtools/apex-log-parser/types";

const FIXTURES = join(__dirname, "eval", "fixtures");

const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.log`), "utf-8");

const HEADER =
  "64.0 APEX_CODE,FINE;APEX_PROFILING,FINE;CALLOUT,NONE;DATA_ACCESS,NONE;DB,INFO;NBA,NONE;SYSTEM,NONE;VALIDATION,NONE;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,NONE";

/** Every node the tree holds, which is what `walkLog` reaches. */
function tree(node: LogEvent, into: LogEvent[] = []): LogEvent[] {
  for (const child of node.children) {
    into.push(child);
    tree(child, into);
  }
  return into;
}

describe("parser contract", () => {
  describe("ApexLog.size", () => {
    const log = [
      HEADER,
      "09:00:00.1 (1000)|EXECUTION_STARTED",
      "09:00:00.1 (2000)|USER_DEBUG|[1]|DEBUG|£100 naïve 🙂",
      "09:00:00.1 (3000)|EXECUTION_FINISHED",
      "",
    ].join("\n");

    // Documented as bytes, but counted in UTF-16 code units, so it under-reads
    // any log that is not ASCII. `apexlog_get_summary` publishes it as
    // `fileSizeBytes`, so this case failing is the signal that the parser fixed
    // it and the figure moved — apex-dev-tools/apex-log-parser#70, due in 0.2.0.
    it("counts UTF-16 code units, not bytes", () => {
      const { size } = parse(log);

      expect(size).toBe(log.length);
      expect(size).toBeLessThan(Buffer.byteLength(log, "utf8"));
    });
  });

  describe("governorLimits.peak.heapSize", () => {
    // Heap is a level and not a counter, so the transaction peak is the highest
    // figure any namespace reported and never the sum of them. Summing would
    // report 300000 here, half again over what the platform measured.
    const namespaceBlock = (namespace: string, heap: number): string =>
      [
        `09:00:00.9 (9000)|LIMIT_USAGE_FOR_NS|${namespace}|`,
        "  Number of SOQL queries: 0 out of 100",
        `  Maximum heap size: ${heap} out of 6000000`,
        "",
      ].join("\n");

    const log = [
      HEADER,
      "09:00:00.1 (1000)|EXECUTION_STARTED",
      "09:00:00.9 (9000)|CUMULATIVE_LIMIT_USAGE",
      namespaceBlock("(default)", 200000),
      namespaceBlock("core_pkg", 100000),
      "09:00:00.9 (9000)|CUMULATIVE_LIMIT_USAGE_END",
      "09:00:01.0 (10000)|EXECUTION_FINISHED",
      "",
    ].join("\n");

    it("reports the highest namespace figure, not their sum", () => {
      expect(parse(log).governorLimits.peak.heapSize.used).toBe(200000);
    });
  });

  describe("heap measures", () => {
    const heapLog = parse(fixture("heap-heavy"));

    const eventNamed = (name: string): LogEvent => {
      const event = tree(heapLog).find((node) => node.text === name);
      if (!event) {
        throw new Error(`${name} is not in heap-heavy.log`);
      }
      return event;
    };

    // The three do not agree, and #99 ranks operations on them: `churn()` frees
    // all it takes, so its net is zero and its peak a fifth of its gross. One
    // of them published as "heap used" would read the path as free.
    it("keeps net, gross and peak apart", () => {
      const churn = eventNamed("HeapService.churn()");

      expect(churn.heapAllocated.total).toBe(0);
      expect(churn.heapGross.total).toBe(200_000);
      expect(churn.heapPeak).toBe(100_000);
    });

    // A cumulative block states heap as zero, so the events are the only heap
    // figure the log gives. `apexlog_get_summary` publishes this as its
    // `heapSize` row.
    it("takes the transaction figure from the events, not the limit block", () => {
      const [snapshot] = heapLog.governorLimits.snapshots;

      expect(snapshot?.limits.heapSize.used).toBe(0);
      expect(heapLog.governorLimits.peak.heapSize.used).toBe(750_000);
    });
  });

  describe("LogEvent.category", () => {
    // `kindOf` in tools/operations.ts drops an event with no category before it
    // looks at anything else, so a timed event without one would be ranked
    // nowhere and its time reported nowhere.
    it.each(["governor-heavy", "minimal"])(
      "is set on every event that carries a duration (%s)",
      (name) => {
        const timed = tree(parse(fixture(name))).filter(
          (node) => node.duration.total > 0,
        );

        expect(timed.length).toBeGreaterThan(0);
        expect(timed.filter((node) => node.category === "")).toEqual([]);
      },
    );

    // The two types `KIND_BY_TYPE` places by name are reached after that test,
    // so each has to carry a category of its own.
    it("is set on the types this server places by name", () => {
      const log = parse(
        [
          HEADER,
          "09:00:00.1 (1000)|EXECUTION_STARTED",
          "09:00:00.1 (2000)|ENTERING_MANAGED_PKG|core_pkg",
          "09:00:00.1 (3000)|SOSL_EXECUTE_BEGIN|[1]|FIND 'x'",
          "09:00:00.1 (4000)|SOSL_EXECUTE_END|[1]|Rows:0",
          "09:00:00.1 (5000)|EXECUTION_FINISHED",
          "",
        ].join("\n"),
      );
      const categoryOf = (type: string) =>
        tree(log).find((node) => node.type === type)?.category;

      expect(categoryOf("ENTERING_MANAGED_PKG")).not.toBe("");
      expect(categoryOf("SOSL_EXECUTE_BEGIN")).not.toBe("");
    });
  });

  describe("logIssues and thrownCount", () => {
    // Closed, so the only issues are the ones the case is about: a log that
    // ends mid-frame raises an `Unexpected-End` of its own.
    const failing = (...lines: string[]): string =>
      [
        HEADER,
        "09:00:00.1 (1000)|EXECUTION_STARTED",
        ...lines,
        "09:00:00.1 (9000)|EXECUTION_FINISHED",
        "",
      ].join("\n");

    // `apexlog_get_summary.fatalErrors` reads both halves: the message names the
    // failure and the stack names the code. Both come off one issue.
    it("states a fatal's message as the summary and its stack as the description", () => {
      const { logIssues } = parse(
        failing(
          "09:00:00.1 (4000)|FATAL_ERROR|System.LimitException: Apex CPU time limit exceeded",
          "Class.Searcher.search: line 31, column 1",
          "Class.Service.run: line 102, column 1",
        ),
      );

      expect(logIssues).toEqual([
        {
          startTime: 4000,
          eventIndex: 2,
          summary: "System.LimitException: Apex CPU time limit exceeded",
          description:
            "Class.Searcher.search: line 31, column 1\nClass.Service.run: line 102, column 1",
          type: "fatal",
        },
      ]);
    });

    // This is what makes `fatalErrors` safe to report as a table: one real log
    // throws 4,501 times for three messages. `exceptions` holds every
    // occurrence, so a tool reading that would return thousands of rows.
    it("holds one issue per distinct failure while exceptions holds every one", () => {
      // On `fatal`, which is the type the summary reads. An `EXCEPTION_THROWN`
      // raises an issue only when its message names a `System.LimitException`,
      // so deduping that type would exercise a path no tool looks at.
      const fatal = "|FATAL_ERROR|System.LimitException: Apex CPU time limit exceeded";
      const log = parse(
        failing(`09:00:00.1 (2000)${fatal}`, `09:00:00.1 (3000)${fatal}`),
      );

      expect(log.logIssues.filter((issue) => issue.type === "fatal")).toHaveLength(1);
      expect(log.exceptions).toHaveLength(2);
    });

    // `thrownCount` is the magnitude the summary reports beside `fatalErrors`,
    // so it must not double-count the fatal that the table already names.
    it("counts a thrown exception and not the fatal error", () => {
      const log = parse(
        failing(
          "09:00:00.1 (2000)|EXCEPTION_THROWN|[12]|System.DmlException: Update failed",
          "09:00:00.1 (4000)|FATAL_ERROR|System.DmlException: Update failed",
        ),
      );

      expect(log.exceptions.map((event) => event.type)).toEqual([
        "EXCEPTION_THROWN",
        "FATAL_ERROR",
      ]);
      expect(log.thrownCount.total).toBe(1);
    });
  });

  describe("ApexLog.isTruncated", () => {
    // `apexlog_get_summary.truncated` is this flag, and the figures beside it
    // are floors when it is set. It follows the regions the platform said it
    // dropped, so a log that merely ends mid-frame does not raise it.
    it("is set by a region the platform dropped, not by an unclosed frame", () => {
      const dropped = parse(fixture("truncated"));

      expect(dropped.truncation.regions.map((region) => region.kind)).toEqual([
        "skipped-lines",
        "max-size",
      ]);
      expect(dropped.truncation.totalSkippedBytes).toBe(14_680_064);
      expect(dropped.isTruncated).toBe(true);

      const unclosed = parse(
        [
          HEADER,
          "09:00:00.1 (1000)|EXECUTION_STARTED",
          "09:00:00.1 (2000)|METHOD_ENTRY|[1]|01pEa00000Never|Never.returns()",
          "",
        ].join("\n"),
      );

      expect(unclosed.truncatedEvents.length).toBeGreaterThan(0);
      expect(unclosed.truncation.regions).toEqual([]);
      expect(unclosed.isTruncated).toBe(false);
    });
  });

  describe("ALL_LIMIT_METRICS", () => {
    // Every tool reports these thirteen as a fixed table, and the suites that
    // check them derive their expectations from this list, so it is pinned once
    // here — including the order, which the tables are emitted in.
    it("states the thirteen governor metrics, in report order", () => {
      expect(ALL_LIMIT_METRICS.map((metric) => metric.key)).toEqual([
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
      ]);
    });
  });

  describe("LOG_LEVEL", () => {
    // The `debugLevel` parameter's enum is built from these, so a renamed or
    // dropped level would change the tool's public schema.
    it("states the eight levels a trace flag accepts", () => {
      expect(Object.values(LOG_LEVEL)).toEqual([
        "NONE",
        "ERROR",
        "WARN",
        "INFO",
        "DEBUG",
        "FINE",
        "FINER",
        "FINEST",
      ]);
    });
  });
});
