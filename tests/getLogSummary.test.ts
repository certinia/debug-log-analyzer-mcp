/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { getLogSummaryTool } from "../src/tools/getLogSummary";
import { logEvent, rootLog, type NodeSpec } from "./support/logEvents";
import { DEBUG_CATEGORIES } from "../src/logLevels";
import { LIMIT_METRICS } from "../src/apexLog";
import type {
  ApexLog,
  GovernorLimits,
  Limits,
  LogIssue,
  NamespaceLimits,
} from "../src/apexLog";

const counts = { total: 0, self: 0 };

describe("getLogSummary", () => {
  // From the parser, so the set cannot drift from what the tool emits.
  // `tests/parserContract.test.ts` pins the list itself.
  const LIMIT_NAMES = Object.keys(LIMIT_METRICS);

  const limitsOf = (
    used: Partial<Record<keyof Limits, number>>,
    limit = 100,
  ): Limits =>
    Object.fromEntries(
      LIMIT_NAMES.map((name) => [
        name,
        { used: used[name] ?? 0, limit, percentUsed: null },
      ]),
    ) as Limits;

  const namespaceLimitsOf = (
    used: Partial<Record<keyof Limits, number>>,
    peakUsed = used,
  ): NamespaceLimits => ({ final: limitsOf(used), peak: limitsOf(peakUsed) });

  const governorLimitsOf = ({
    used = {},
    peakUsed = used,
    byNamespace = new Map<string, NamespaceLimits>(),
  }: {
    used?: Partial<Record<keyof Limits, number>>;
    peakUsed?: Partial<Record<keyof Limits, number>>;
    byNamespace?: Map<string, NamespaceLimits>;
  } = {}): GovernorLimits => ({
    snapshots: [],
    final: limitsOf(used),
    peak: limitsOf(peakUsed),
    byNamespace,
  });

  // An empty log of the builder's, with what these cases read beside the tree.
  const createMockApexLog = (overrides: Partial<ApexLog> = {}): ApexLog => {
    const log = {
      ...rootLog(12_500_000_000),
      size: 15000,
      namespaces: ["default", "MyNamespace"],
      thrownCount: counts,
      limits: governorLimitsOf({
        used: { soqlQueries: 5, dmlStatements: 3, cpuTime: 1500 },
      }),
      ...overrides,
    };
    // Over the events the case gave, as the parser's index is over the log's.
    const ofType = (...types: string[]) =>
      [...log.events].filter(({ type }) => types.includes(type));
    return { ...log, ofType } as unknown as ApexLog;
  };

  const summaryOf = (
    overrides: Partial<ApexLog> = {},
  ): ReturnType<typeof getLogSummaryTool.run> =>
    getLogSummaryTool.run(createMockApexLog(overrides), {});

  // The lists the parser fills beside the tree: every event, every throw and fatal, and the columns.
  const logOf = (...frames: NodeSpec[]): Partial<ApexLog> => {
    const { children, events, exceptions, columns } = rootLog(0, ...frames);
    return { children, events, exceptions, columns };
  };

  describe("the transaction", () => {
    it("should report how big the log is, how long it ran and whether it is whole", () => {
      const summary = summaryOf();

      expect(summary.fileSizeBytes).toBe(15000);
      expect(summary.durationTotalMs).toBe(12500);
      expect(summary.truncated).toBe(false);
      expect(summary.skippedBytes).toBeUndefined();
      expect(summary.namespaces).toEqual(["default", "MyNamespace"]);
    });

    it("should say when the platform dropped part of the log, and how much", () => {
      // Every figure in a partial log is a floor, so a CPU time read from one as
      // though it were a total is the worst answer the server can give.
      const summary = summaryOf({
        isTruncated: true,
        truncation: {
          regions: [{ kind: "skipped-lines", startTime: 8000 }],
          totalSkippedBytes: 14_680_064,
        },
      });

      expect(summary.truncated).toBe(true);
      expect(summary.truncatedBy).toEqual(["skipped-lines"]);
      expect(summary.skippedBytes).toBe(14_680_064);
    });

    it("should say when the log stopped inside a frame it never closed", () => {
      // The platform dropping content and the log stopping mid-frame are
      // different shapes, and the parser only calls the first one truncation. A
      // log cut off by an interrupted download states no region at all, and
      // nothing else in the response would say its figures are floors.
      const summary = summaryOf({
        unclosedFrames: [{ ...logEvent({ type: "METHOD_ENTRY", isFrame: true }), endedBy: "log-end" }] as ApexLog["unclosedFrames"],
      });

      expect(summary.truncated).toBe(true);
      // Neither is reported: both read the regions the platform's own truncation
      // fills, and this log has none. Stating 0 skipped bytes under no reason at
      // all would name a loss the platform never made.
      expect(summary.truncatedBy).toBeUndefined();
      expect(summary.skippedBytes).toBeUndefined();
    });

    // An exception closes the frames it unwinds at a later exit line, and the
    // log goes on. Real logs that throw carry such frames and are whole.
    it("should not call a log partial for a frame an exception unwound", () => {
      const summary = summaryOf({
        unclosedFrames: [{ ...logEvent({ type: "METHOD_ENTRY", isFrame: true }), endedBy: "unwind" }] as ApexLog["unclosedFrames"],
      });

      expect(summary.truncated).toBe(false);
    });

    it("should report a zero byte count on a log that hit the maximum size", () => {
      // A max-size region states no byte count for what it lost, so 0 beside a
      // true `truncated` is a real answer rather than a missing one.
      const summary = summaryOf({
        isTruncated: true,
        truncation: {
          regions: [{ kind: "max-size", startTime: 9000 }],
          totalSkippedBytes: 0,
        },
      });

      expect(summary.truncatedBy).toEqual(["max-size"]);
      expect(summary.skippedBytes).toBe(0);
    });

    it("should name both losses when a log suffered both", () => {
      // Two real logs carry both, and a reader of `skippedBytes` alone
      // would take a hole's byte count for the whole extent of the loss.
      const summary = summaryOf({
        isTruncated: true,
        truncation: {
          regions: [
            { kind: "skipped-lines", startTime: 8000 },
            { kind: "max-size", startTime: 9000 },
          ],
          totalSkippedBytes: 14_680_064,
        },
      });

      expect(summary.truncatedBy).toEqual(["skipped-lines", "max-size"]);
    });

    it("should clip a frames cell one long frame would otherwise fill", () => {
      // A single frame runs to 1,081 characters in real logs, so capping
      // the frame count alone leaves the cell unbounded.
      const summary = summaryOf({
        issues: [
          {
            summary: "System.CalloutException: bad response",
            description: `${"x".repeat(5000)}\nClass.Service.run: line 1, column 1`,
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      const { frames } = summary.fatalErrors[0];
      expect(frames).toHaveLength(401);
      expect(frames.endsWith("…")).toBe(true);
    });

    it("should report what killed the transaction, and where", () => {
      const summary = summaryOf({
        issues: [
          {
            summary: "System.LimitException: Apex CPU time limit exceeded",
            description:
              "Class.Searcher.search: line 31, column 1\nClass.Service.run: line 102, column 1",
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.fatalErrors).toEqual([
        {
          message: "System.LimitException: Apex CPU time limit exceeded",
          frames:
            "Class.Searcher.search: line 31, column 1 | Class.Service.run: line 102, column 1",
        },
      ]);
    });

    it("should state the innermost frames and say that it dropped the rest", () => {
      // A real log states 52,009 characters of stack. Three frames name the
      // failing call and its callers; the rest costs more than it says. Half of
      // real logs have a fourth, so the drop has to be visible or a deep
      // stack reads like a shallow one.
      const summary = summaryOf({
        issues: [
          {
            summary: "System.LimitException: Maximum stack depth reached: 1001",
            description: ["one", "two", "three", "four", "five"].join("\n"),
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.fatalErrors[0].frames).toBe("one | two | three | …");
    });

    it("should not claim a drop on a stack that fits", () => {
      const summary = summaryOf({
        issues: [
          {
            summary: "System.NullPointerException: Attempt to de-reference null",
            description: ["one", "two", "three"].join("\n"),
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.fatalErrors[0].frames).toBe("one | two | three");
    });

    it("should not spend a frame on a blank line inside the stack", () => {
      // The limit counts real frames. Counting raw lines let a blank one inside
      // the stack cost a frame and still claim a drop, so a stack that fits read
      // as one that had been cut.
      const summary = summaryOf({
        issues: [
          {
            summary: "System.NullPointerException: Attempt to de-reference null",
            description: ["one", "", "two", "three"].join("\n"),
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.fatalErrors[0].frames).toBe("one | two | three");
    });

    it("should clip a message where it runs into prose", () => {
      // A DmlException embeds the whole validation message a user would see -
      // 1,070 characters at the worst of real logs. The kept part carries
      // the exception class, the offending row and the error code.
      const prose = "x".repeat(400);
      const summary = summaryOf({
        issues: [
          {
            summary: `System.DmlException: Update failed. first error: CANNOT_EXECUTE_FLOW_TRIGGER, ${prose}`,
            description: "Class.Service.run: line 1, column 1",
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      const { message } = summary.fatalErrors[0];
      expect(message).toHaveLength(201);
      expect(message.endsWith("…")).toBe(true);
      expect(message).toContain("CANNOT_EXECUTE_FLOW_TRIGGER");
    });

    it("should keep the frames cell on a fatal the log gave no stack for", () => {
      // An absent key would put the table out of its one-header form, which
      // costs more than the empty cell it saves.
      const summary = summaryOf({
        issues: [
          {
            summary: "Internal Salesforce.com Error",
            description: "",
            type: "fatal",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.fatalErrors).toEqual([
        { message: "Internal Salesforce.com Error", frames: "" },
      ]);
    });

    it("should ignore the issues that are not a fatal", () => {
      // `error` repeats a fatal's message without its stack, and `skip` and
      // `unexpected` say what `truncated` already says.
      const summary = summaryOf({
        issues: [
          {
            summary: "System.DmlException: Update failed",
            description: "",
            type: "error",
            startTime: 8000,
          },
          {
            summary: "Unexpected-Exit",
            description: "An exit event was found without a corresponding entry",
            type: "unexpected",
            startTime: 8100,
          },
        ] as LogIssue[],
      });

      expect(summary.fatalErrors).toBeUndefined();
    });

    it("should report how many exceptions were thrown, zero included", () => {
      // Part of the fixed schema: an absent count could not be told from one
      // the log never carried, and a caught exception is invisible otherwise.
      expect(summaryOf().thrownCount).toBe(0);
      const threw = summaryOf({ thrownCount: { total: 4501, self: 0 } });

      expect(threw.thrownCount).toBe(4501);
    });
  });

  describe("exceptions", () => {
    const thrown = (
      text: string,
      lineNumber: NodeSpec["lineNumber"] = 31,
    ): NodeSpec => ({ type: "EXCEPTION_THROWN", text, lineNumber });

    const method = (text: string, ...children: NodeSpec[]): NodeSpec => ({
      type: "METHOD_ENTRY",
      text,
      children,
    });

    it("should fold repeated throws into one row, most thrown first", () => {
      // One real log throws 4,501 times from one line: a row per throw would
      // be 4,501 rows that say one thing.
      const summary = summaryOf(
        logOf(
          method(
            "Service.save()",
            thrown(
              "System.NullPointerException: Attempt to de-reference a null object",
              44,
            ),
          ),
          method(
            "Service.fetch(Integer)",
            thrown("System.CalloutException: Read timed out"),
            thrown("System.CalloutException: Read timed out"),
          ),
        ),
      );

      expect(summary.exceptionGroupCount).toBe(2);
      expect(summary.exceptions).toEqual([
        {
          message: "System.CalloutException: Read timed out",
          thrownIn: "Service.fetch(Integer)",
          lineNumber: 31,
          thrownCount: 2,
        },
        {
          message:
            "System.NullPointerException: Attempt to de-reference a null object",
          thrownIn: "Service.save()",
          lineNumber: 44,
          thrownCount: 1,
        },
      ]);
    });

    it("should fold one message thrown from several frames into one row, where it was first thrown", () => {
      // A row per frame cost one real log 15 rows for 4 messages.
      const summary = summaryOf(
        logOf(
          method("A.run()", thrown("System.QueryException: no rows", 12)),
          method("B.run()", thrown("System.QueryException: no rows", 40)),
        ),
      );

      expect(summary.exceptions).toEqual([
        {
          message: "System.QueryException: no rows",
          thrownIn: "A.run()",
          lineNumber: 12,
          thrownCount: 2,
        },
      ]);
    });

    it("should name the Apex frame, not the system call or query it was inside", () => {
      const summary = summaryOf(
        logOf({
          type: "CODE_UNIT_STARTED",
          text: "OrderTrigger on Order trigger event AfterUpdate",
          children: [
            {
              type: "SYSTEM_METHOD_ENTRY",
              text: "System.JSON.deserialize(String, System.Type)",
              children: [thrown("System.JSONException: Unexpected character")],
            },
          ],
        }),
      );

      expect(summary.exceptions[0].thrownIn).toBe(
        "OrderTrigger on Order trigger event AfterUpdate",
      );
    });

    it("should state an empty frame and line where the log gives none", () => {
      // `EXTERNAL` is what a managed package states for a line it hides.
      const summary = summaryOf(
        logOf(
          thrown("System.TypeException: Invalid id", null),
          method(
            "pkg.Api.call()",
            thrown("pkg.ApiException: denied", "EXTERNAL"),
          ),
        ),
      );

      expect(summary.exceptions).toEqual([
        {
          message: "System.TypeException: Invalid id",
          thrownIn: "",
          lineNumber: "",
          thrownCount: 1,
        },
        {
          message: "pkg.ApiException: denied",
          thrownIn: "pkg.Api.call()",
          lineNumber: "EXTERNAL",
          thrownCount: 1,
        },
      ]);
    });

    it("should clip a message as a fatal's is clipped", () => {
      const summary = summaryOf(
        logOf(thrown(`System.DmlException: Insert failed. ${"x".repeat(400)}`)),
      );

      const { message } = summary.exceptions[0];
      expect(message).toHaveLength(201);
      expect(message.endsWith("…")).toBe(true);
    });

    it("should fold messages that differ only past the clip, so no two rows read the same", () => {
      const prefix = `System.DmlException: Insert failed. ${"x".repeat(200)}`;
      const summary = summaryOf(
        logOf(thrown(`${prefix} record 1`), thrown(`${prefix} record 2`)),
      );

      expect(summary.exceptions).toHaveLength(1);
      expect(summary.exceptions[0].thrownCount).toBe(2);
    });

    it("should show and fold on the first line, as a fatal does", () => {
      const first =
        "System.DmlException: Insert failed. First exception on row 0; first error: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, OrderTrigger: execution of AfterInsert";
      const summary = summaryOf(
        logOf(
          thrown(`${first}\ncaused by: System.NullPointerException: Attempt to de-reference a null object\nTrigger.OrderTrigger: line 12, column 1: []`),
          thrown(`${first}\ncaused by: System.QueryException: List has no rows for assignment to SObject\nTrigger.OrderTrigger: line 20, column 1: []`),
        ),
      );

      expect(summary.exceptions).toHaveLength(1);
      expect(summary.exceptions[0]).toMatchObject({ message: first, thrownCount: 2 });
    });

    it("should cap the rows and state how many there were", () => {
      // A loop that puts a record id in each message has no bound.
      const throws = Array.from({ length: 25 }, (_, i) =>
        thrown(`System.DmlException: row ${i}`),
      );
      const summary = summaryOf(
        logOf(method("Batch.execute()", ...throws)),
      );

      expect(summary.exceptions).toHaveLength(20);
      expect(summary.exceptionGroupCount).toBe(25);
    });

    it("should leave out the table, and count zero, when nothing was thrown", () => {
      // A fatal alone is not a throw: `fatalErrors` reports it.
      const summary = summaryOf(
        logOf({
          type: "FATAL_ERROR",
          text: "System.LimitException: Apex CPU time limit exceeded",
        }),
      );

      expect(summary.exceptions).toBeUndefined();
      expect(summary.exceptionGroupCount).toBe(0);
    });
  });

  describe("flowErrorCount", () => {
    it("should count the flow element errors at any depth", () => {
      // A flow can fail with no throw and no fatal, so nothing else reports it.
      const summary = summaryOf(
        logOf(
          {
            type: "FLOW_START_INTERVIEWS_BEGIN",
            children: [
              { type: "FLOW_ELEMENT_ERROR" },
              { type: "FLOW_ELEMENT_ERROR" },
            ],
          },
          {
            type: "CODE_UNIT_STARTED",
            children: [{ type: "FLOW_ELEMENT_ERROR" }],
          },
        ),
      );

      expect(summary.flowErrorCount).toBe(3);
    });

    it("should not count a workflow flow action error twice", () => {
      // Every real log with a `WF_FLOW_ACTION_ERROR` also has the
      // `FLOW_ELEMENT_ERROR` of the same failure.
      const summary = summaryOf(
        logOf({
          type: "CODE_UNIT_STARTED",
          children: [
            { type: "FLOW_ELEMENT_ERROR" },
            { type: "WF_FLOW_ACTION_ERROR" },
            { type: "WF_FLOW_ACTION_ERROR_DETAIL" },
          ],
        }),
      );

      expect(summary.flowErrorCount).toBe(1);
    });

    it("should report zero when no flow failed", () => {
      expect(summaryOf().flowErrorCount).toBe(0);
    });
  });

  describe("governorLimits", () => {
    it("should report every limit as a row, including the ones at zero", () => {
      const summary = summaryOf({
        limits: governorLimitsOf({
          used: { cpuTime: 8000, soqlQueries: 50 },
        }),
      });

      expect(summary.governorLimits).toHaveLength(LIMIT_NAMES.length);
      expect(summary.governorLimits).toContainEqual({
        limit: "cpuTime",
        used: 8000,
        max: 100,
      });
      // "No callouts were made" is an answer, and only a reported zero gives it.
      expect(summary.governorLimits).toContainEqual({
        limit: "callouts",
        used: 0,
        max: 100,
      });
    });

    it("should report the peak a limit reached, not where it ended", () => {
      // A counter falls when the frame that spent it exits, so the final figure
      // understates what the platform enforced.
      const summary = summaryOf({
        limits: governorLimitsOf({
          used: { cpuTime: 100 },
          peakUsed: { cpuTime: 8000 },
        }),
      });

      expect(summary.governorLimits).toContainEqual({
        limit: "cpuTime",
        used: 8000,
        max: 100,
      });
    });
  });

  describe("limitsByNamespace", () => {
    it("should report what each namespace consumed", () => {
      const summary = summaryOf({
        limits: governorLimitsOf({
          used: { soqlQueries: 6, cpuTime: 1500 },
          byNamespace: new Map([
            ["srm_pkg", namespaceLimitsOf({ soqlQueries: 4, cpuTime: 900 })],
            ["default", namespaceLimitsOf({ soqlQueries: 2 })],
          ]),
        }),
      });

      expect(summary.limitsByNamespace).toEqual([
        { namespace: "srm_pkg", limit: "soqlQueries", used: 4 },
        { namespace: "srm_pkg", limit: "cpuTime", used: 900 },
        { namespace: "default", limit: "soqlQueries", used: 2 },
      ]);
    });

    it("should report the peak a namespace reached, not where it ended", () => {
      const summary = summaryOf({
        limits: governorLimitsOf({
          byNamespace: new Map([
            ["srm_pkg", namespaceLimitsOf({ soqlQueries: 1 }, { soqlQueries: 4 })],
          ]),
        }),
      });

      expect(summary.limitsByNamespace).toEqual([
        { namespace: "srm_pkg", limit: "soqlQueries", used: 4 },
      ]);
    });

    it("should report no rows when the log attributed nothing to a namespace", () => {
      expect(summaryOf().limitsByNamespace).toEqual([]);
    });
  });

  describe("categories", () => {
    const rowOf = (
      summary: { categories: { debugCategory: string }[] },
      debugCategory: string,
    ) => summary.categories.find((row) => row.debugCategory === debugCategory);

    // The level ties log content to log configuration: what was captured, and
    // what is missing because a category was switched off. Empty where the
    // header declared none, because a level has no zero and a default would
    // state one the log did not.
    it("should state the level each category was captured at", () => {
      const summary = summaryOf({
        debugLevels: { apexCode: "DEBUG", database: "NONE" },
      });

      expect(rowOf(summary, "apexCode")).toMatchObject({ level: "DEBUG" });
      expect(rowOf(summary, "database")).toMatchObject({ level: "NONE" });
      expect(rowOf(summary, "callout")).toMatchObject({ level: "" });
    });

    // `database 0` beside `database NONE` means the queries were not logged;
    // the same row beside `database FINEST` means none ran. Neither reads
    // without the row, so every category is reported.
    it("should report a row for every category, so a zero can be read", () => {
      const summary = summaryOf();

      expect(
        summary.categories.map(
          (row: { debugCategory: string }) => row.debugCategory,
        ),
      ).toEqual([...DEBUG_CATEGORIES, "unattributed"]);
    });

    // A frame is not ranked, but its own time is the transaction's, and the
    // root's own time is the time no event spans. Either left out, the rows
    // would not add up to the log.
    it("should file a frame's self time under its category, and the root's as unattributed", () => {
      const summary = summaryOf({
        duration: { total: 10_000_000_000, self: 1_000_000_000 },
        ...logOf(
          { type: "USER_INFO", debugCategory: "apexCode" },
          {
            type: "EXECUTION_STARTED",
            isFrame: true,
            debugCategory: "apexCode",
            totalNs: 9_000_000_000,
            selfNs: 2_000_000_000,
            children: [
              {
                type: "METHOD_ENTRY",
                isFrame: true,
                debugCategory: "apexCode",
                totalNs: 7_000_000_000,
              },
            ],
          },
        ),
      });

      expect(rowOf(summary, "apexCode")).toMatchObject({
        operationCount: 1,
        durationSelfMs: 9000,
        selfPercentage: 90,
      });
      expect(rowOf(summary, "unattributed")).toEqual({
        debugCategory: "unattributed",
        level: "",
        operationCount: 0,
        durationSelfMs: 1000,
        selfPercentage: 10,
      });
    });

    it("should count the operations of a category and sum their self time", () => {
      const summary = summaryOf(
        logOf(
          {
            type: "METHOD_ENTRY",
            isFrame: true,
            debugCategory: "apexCode",
            totalNs: 2_000_000_000,
            children: [
              {
                type: "SOQL_EXECUTE_BEGIN",
                isFrame: true,
                debugCategory: "database",
                totalNs: 1_000_000_000,
              },
            ],
          },
          {
            type: "METHOD_ENTRY",
            isFrame: true,
            debugCategory: "apexCode",
            totalNs: 500_000_000,
          },
        ),
      );

      expect(rowOf(summary, "apexCode")).toEqual({
        debugCategory: "apexCode",
        level: "",
        operationCount: 2,
        durationSelfMs: 2500,
        selfPercentage: 20,
      });
      expect(rowOf(summary, "database")).toEqual({
        debugCategory: "database",
        level: "",
        operationCount: 1,
        durationSelfMs: 1000,
        selfPercentage: 8,
      });
    });

    // A Visualforce formula carries the timeline category `System`, so reading
    // that would report half a Visualforce transaction as system time.
    it("should file an operation under the category that gates it", () => {
      const summary = summaryOf(
        logOf({
          type: "VF_EVALUATE_FORMULA_BEGIN",
          isFrame: true,
          debugCategory: "visualforce",
          selfNs: 6_000_000_000,
        }),
      );

      expect(rowOf(summary, "visualforce")).toMatchObject({
        operationCount: 1,
        durationSelfMs: 6000,
      });
      expect(rowOf(summary, "system")).toMatchObject({
        operationCount: 0,
        durationSelfMs: 0,
      });
    });

    it("should report zeros rather than divide by a log that ran no time", () => {
      const summary = summaryOf({
        duration: { total: 0, self: 0 },
        children: [],
      });

      expect(summary.durationTotalMs).toBe(0);
      summary.categories.forEach(
        (row: { operationCount: number; selfPercentage: number }) => {
          expect(row.operationCount).toBe(0);
          expect(row.selfPercentage).toBe(0);
        },
      );
    });
  });
});
