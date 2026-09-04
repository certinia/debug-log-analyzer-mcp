/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";

import {
  getLogSummary,
  LogSummaryArgs,
  getLogSummaryToolConfig,
} from "../src/tools/getLogSummary";
import { clearApexLogCache } from "../src/tools/apexLogSource";
import { OPERATION_KINDS } from "../src/tools/operations";
import { parse } from "@apexdevtools/apex-log-parser";
import type {
  ApexLog,
  ApexLogParser,
  LogEvent,
} from "@apexdevtools/apex-log-parser";
import {
  ALL_LIMIT_METRICS,
  type GovernorLimits,
  type Limits,
  type LogIssue,
  type NamespaceLimits,
} from "@apexdevtools/apex-log-parser/types";
import { decode } from "@toon-format/toon";

// Mock the dependencies
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

const counts = { total: 0, self: 0 };

/** A timed node, as the tools read one: a sub-category and its own time. */
const node = ({
  type = null,
  category,
  selfNs = 0,
  children = [],
}: {
  type?: string | null;
  category?: string;
  selfNs?: number;
  children?: LogEvent[];
}): LogEvent =>
  ({
    type,
    category,
    children,
    text: type ?? "",
    namespace: "default",
    lineNumber: null,
    duration: { total: selfNs, self: selfNs },
    soqlCount: counts,
    dmlCount: counts,
    soslCount: counts,
    soqlRowCount: counts,
    dmlRowCount: counts,
    soslRowCount: counts,
    thrownCount: counts,
  }) as unknown as LogEvent;

describe("getLogSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The suites reuse one path with different content, which the cache would
    // otherwise hide.
    clearApexLogCache();
  });

  describe("tool configuration", () => {
    it("should annotate only the hints that carry meaning for a read-only tool", () => {
      expect(getLogSummaryToolConfig.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
    });
  });

  function toonDecode(result: any): any {
    return decode(result.content[0].text) as any;
  }

  // From the parser, so the set cannot drift from what the tool emits.
  // `tests/parserContract.test.ts` pins the list itself.
  const LIMIT_NAMES = ALL_LIMIT_METRICS.map((metric) => metric.key);

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

  const createMockApexLog = (overrides: Partial<ApexLog> = {}): ApexLog =>
    ({
      type: null,
      text: "LOG_ROOT",
      size: 15000,
      debugLevels: {},
      namespaces: ["default", "MyNamespace"],
      logIssues: [] as LogIssue[],
      isTruncated: false,
      truncation: { regions: [], totalSkippedBytes: 0 },
      truncatedEvents: [] as LogEvent[],
      thrownCount: counts,
      governorLimits: governorLimitsOf({
        used: { soqlQueries: 5, dmlStatements: 3, cpuTime: 1500 },
      }),
      logParser: {} as ApexLogParser,
      parent: null,
      children: [] as LogEvent[],
      lineNumber: null,
      duration: { total: 12_500_000_000, self: 12_500_000_000 },
      ...overrides,
    }) as unknown as ApexLog;

  const summaryOf = async (
    overrides: Partial<ApexLog> = {},
    logFilePath = "/path/to/test-log.log",
  ) => {
    mockFs.stat.mockResolvedValue(mockStats);
    mockFs.readFile.mockResolvedValue("mock log content");
    mockParse.mockReturnValue(createMockApexLog(overrides));

    return toonDecode(await getLogSummary({ logFilePath } as LogSummaryArgs));
  };

  describe("the transaction", () => {
    it("should report how big the log is, how long it ran and whether it is whole", async () => {
      const summary = await summaryOf();

      expect(mockFs.stat).toHaveBeenCalledWith("/path/to/test-log.log", {
        bigint: true,
      });
      expect(mockParse).toHaveBeenCalledWith("mock log content");
      expect(summary.fileSizeBytes).toBe(15000);
      expect(summary.durationTotalMs).toBe(12500);
      expect(summary.truncated).toBe(false);
      expect(summary.skippedBytes).toBeUndefined();
      expect(summary.namespaces).toEqual(["default", "MyNamespace"]);
    });

    it("should say when the platform dropped part of the log, and how much", async () => {
      // Every figure in a partial log is a floor, so a CPU time read from one as
      // though it were a total is the worst answer the server can give.
      const summary = await summaryOf({
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

    it("should say when the log stopped inside a frame it never closed", async () => {
      // The platform dropping content and the log stopping mid-frame are
      // different shapes, and the parser only calls the first one truncation. A
      // log cut off by an interrupted download states no region at all, and
      // nothing else in the response would say its figures are floors.
      const summary = await summaryOf({
        truncatedEvents: [node({ type: "METHOD_ENTRY", category: "Apex" })],
      });

      expect(summary.truncated).toBe(true);
      // Neither is reported: both read the regions the platform's own truncation
      // fills, and this log has none. Stating 0 skipped bytes under no reason at
      // all would name a loss the platform never made.
      expect(summary.truncatedBy).toBeUndefined();
      expect(summary.skippedBytes).toBeUndefined();
    });

    it("should report a zero byte count on a log that hit the maximum size", async () => {
      // A max-size region states no byte count for what it lost, so 0 beside a
      // true `truncated` is a real answer rather than a missing one.
      const summary = await summaryOf({
        isTruncated: true,
        truncation: {
          regions: [{ kind: "max-size", startTime: 9000 }],
          totalSkippedBytes: 0,
        },
      });

      expect(summary.truncatedBy).toEqual(["max-size"]);
      expect(summary.skippedBytes).toBe(0);
    });

    it("should name both losses when a log suffered both", async () => {
      // Two of 124 real logs carry both, and a reader of `skippedBytes` alone
      // would take a hole's byte count for the whole extent of the loss.
      const summary = await summaryOf({
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

    it("should clip a frames cell one long frame would otherwise fill", async () => {
      // A single frame runs to 1,081 characters on a 124-log corpus, so capping
      // the frame count alone leaves the cell unbounded.
      const summary = await summaryOf({
        logIssues: [
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

    it("should report every log category and its level", async () => {
      // The levels tie log content to log configuration: what was captured, and
      // what is missing because a category was switched off.
      const summary = await summaryOf({
        debugLevels: { apexCode: "DEBUG", database: "NONE" },
      });

      expect(summary.debugLevels).toEqual([
        { logCategory: "APEX_CODE", level: "DEBUG" },
        { logCategory: "DB", level: "NONE" },
      ]);
    });

    it("should report what killed the transaction, and where", async () => {
      const summary = await summaryOf({
        logIssues: [
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

    it("should state the innermost frames and say that it dropped the rest", async () => {
      // A real log states 52,009 characters of stack. Three frames name the
      // failing call and its callers; the rest costs more than it says. Half of
      // a 124-log corpus has a fourth, so the drop has to be visible or a deep
      // stack reads like a shallow one.
      const summary = await summaryOf({
        logIssues: [
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

    it("should not claim a drop on a stack that fits", async () => {
      const summary = await summaryOf({
        logIssues: [
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

    it("should not spend a frame on a blank line inside the stack", async () => {
      // The limit counts real frames. Counting raw lines let a blank one inside
      // the stack cost a frame and still claim a drop, so a stack that fits read
      // as one that had been cut.
      const summary = await summaryOf({
        logIssues: [
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

    it("should clip a message where it runs into prose", async () => {
      // A DmlException embeds the whole validation message a user would see —
      // 1,070 characters at the worst of 124 real logs. The kept part carries
      // the exception class, the offending row and the error code.
      const prose = "x".repeat(400);
      const summary = await summaryOf({
        logIssues: [
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

    it("should keep the frames cell on a fatal the log gave no stack for", async () => {
      // An absent key would put the table out of its one-header form, which
      // costs more than the empty cell it saves.
      const summary = await summaryOf({
        logIssues: [
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

    it("should ignore the issues that are not a fatal", async () => {
      // `error` repeats a fatal's message without its stack, and `skip` and
      // `unexpected` say what `truncated` already says.
      const summary = await summaryOf({
        logIssues: [
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

    it("should report how many exceptions were thrown, zero included", async () => {
      // Part of the fixed schema: an absent count could not be told from one
      // the log never carried, and a caught exception is invisible otherwise.
      expect((await summaryOf()).thrownCount).toBe(0);
      // A second path, because the parse cache holds one slot and keys on it.
      const threw = await summaryOf(
        { thrownCount: { total: 4501, self: 0 } },
        "/path/to/threw.log",
      );

      expect(threw.thrownCount).toBe(4501);
    });

    it("should not echo the log file path back to the caller", async () => {
      // The caller supplied the path, so repeating it back only costs tokens.
      const summary = await summaryOf({}, "/Users/test/apex-debug-123.log");

      expect(summary.file).toBeUndefined();
      expect(summary.logFilePath).toBeUndefined();
    });
  });

  describe("governorLimits", () => {
    it("should report every limit as a row, including the ones at zero", async () => {
      const summary = await summaryOf({
        governorLimits: governorLimitsOf({
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

    it("should report the peak a limit reached, not where it ended", async () => {
      // A counter falls when the frame that spent it exits, so the final figure
      // understates what the platform enforced.
      const summary = await summaryOf({
        governorLimits: governorLimitsOf({
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
    it("should report what each namespace consumed", async () => {
      const summary = await summaryOf({
        governorLimits: governorLimitsOf({
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

    it("should report the peak a namespace reached, not where it ended", async () => {
      const summary = await summaryOf({
        governorLimits: governorLimitsOf({
          byNamespace: new Map([
            ["srm_pkg", namespaceLimitsOf({ soqlQueries: 1 }, { soqlQueries: 4 })],
          ]),
        }),
      });

      expect(summary.limitsByNamespace).toEqual([
        { namespace: "srm_pkg", limit: "soqlQueries", used: 4 },
      ]);
    });

    it("should report no rows when the log attributed nothing to a namespace", async () => {
      expect((await summaryOf()).limitsByNamespace).toEqual([]);
    });
  });

  describe("timeByKind", () => {
    it("should report a row for every kind, so a zero can be read", async () => {
      const summary = await summaryOf();

      expect(summary.timeByKind.map((row: { kind: string }) => row.kind)).toEqual(
        [...OPERATION_KINDS],
      );
    });

    it("should count the operations of a kind and sum their self time", async () => {
      const summary = await summaryOf({
        children: [
          node({
            type: "METHOD_ENTRY",
            category: "Apex",
            selfNs: 2_000_000_000,
            children: [
              node({
                type: "SOQL_EXECUTE_BEGIN",
                category: "SOQL",
                selfNs: 1_000_000_000,
              }),
            ],
          }),
          node({
            type: "METHOD_ENTRY",
            category: "Apex",
            selfNs: 500_000_000,
          }),
        ],
      });

      const rowOf = (kind: string) =>
        summary.timeByKind.find((row: { kind: string }) => row.kind === kind);

      expect(rowOf("method")).toEqual({
        kind: "method",
        logCategory: "APEX_CODE",
        operationCount: 2,
        durationSelfMs: 2500,
        selfPercentage: 20,
      });
      expect(rowOf("soql")).toEqual({
        kind: "soql",
        logCategory: "DB",
        operationCount: 1,
        durationSelfMs: 1000,
        selfPercentage: 8,
      });
    });

    it("should name the trace category that decides whether a kind was logged", async () => {
      // A `soql 0` row beside `DB NONE` means the queries were not logged; the
      // same row beside `DB FINEST` means none ran.
      const summary = await summaryOf();
      const rowOf = (kind: string) =>
        summary.timeByKind.find((row: { kind: string }) => row.kind === kind);

      expect(rowOf("soql").logCategory).toBe("DB");
      expect(rowOf("systemMethod").logCategory).toBe("SYSTEM");
      expect(rowOf("workflow").logCategory).toBe("WORKFLOW");
    });

    it("should report zeros rather than divide by a log that ran no time", async () => {
      const summary = await summaryOf({
        duration: { total: 0, self: 0 },
        children: [],
      });

      expect(summary.durationTotalMs).toBe(0);
      summary.timeByKind.forEach(
        (row: { operationCount: number; selfPercentage: number }) => {
          expect(row.operationCount).toBe(0);
          expect(row.selfPercentage).toBe(0);
        },
      );
    });
  });

  describe("error handling", () => {
    it("should throw an error when log file does not exist", async () => {
      mockFs.stat.mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        }),
      );

      await expect(
        getLogSummary({ logFilePath: "/path/to/nonexistent.log" }),
      ).rejects.toThrow("Log file not found: /path/to/nonexistent.log");
      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("names the cause when the file is there but cannot be opened", async () => {
      mockFs.stat.mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );

      await expect(
        getLogSummary({ logFilePath: "/path/to/restricted.log" }),
      ).rejects.toThrow("Cannot read log file /path/to/restricted.log: EACCES");
    });

    it("should propagate file read errors", async () => {
      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockRejectedValue(new Error("Failed to read file"));

      await expect(
        getLogSummary({ logFilePath: "/path/to/unreadable.log" }),
      ).rejects.toThrow("Failed to read file");
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should propagate parsing errors", async () => {
      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("invalid log content");
      mockParse.mockImplementation(() => {
        throw new Error("Failed to parse log");
      });

      await expect(
        getLogSummary({ logFilePath: "/path/to/corrupted.log" }),
      ).rejects.toThrow("Failed to parse log");
      expect(mockParse).toHaveBeenCalledWith("invalid log content");
    });
  });
});
