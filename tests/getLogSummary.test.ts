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
import {
  parse,
  ApexLog,
  LogLine,
  GovernorLimits,
  Limits,
  LogIssue,
  ApexLogParser,
} from "../src/ApexLogParser";
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

jest.mock("../src/ApexLogParser", () => ({
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
  subCategory,
  selfNs = 0,
  children = [],
  isTruncated = false,
}: {
  type?: string | null;
  subCategory?: string;
  selfNs?: number;
  children?: LogLine[];
  isTruncated?: boolean;
}): LogLine =>
  ({
    type,
    subCategory,
    children,
    isTruncated,
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
    totalThrownCount: 0,
  }) as unknown as LogLine;

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

  const LIMIT_NAMES: (keyof Limits)[] = [
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

  const limitsOf = (
    used: Partial<Record<keyof Limits, number>>,
    limit = 100,
  ): Limits =>
    Object.fromEntries(
      LIMIT_NAMES.map((name) => [name, { used: used[name] ?? 0, limit }]),
    ) as Limits;

  const governorLimitsOf = (
    used: Partial<Record<keyof Limits, number>> = {},
    byNamespace = new Map<string, Limits>(),
  ): GovernorLimits =>
    ({ ...limitsOf(used), byNamespace }) as unknown as GovernorLimits;

  const createMockApexLog = (overrides: Partial<ApexLog> = {}): ApexLog =>
    ({
      type: null,
      text: "LOG_ROOT",
      size: 15000,
      debugLevels: [],
      namespaces: ["default", "MyNamespace"],
      logIssues: [] as LogIssue[],
      parsingErrors: [] as string[],
      governorLimits: governorLimitsOf({
        soqlQueries: 5,
        dmlStatements: 3,
        cpuTime: 1500,
      }),
      logParser: {} as ApexLogParser,
      parent: null,
      children: [] as LogLine[],
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
      expect(summary.parsingErrorCount).toBe(0);
      expect(summary.namespaces).toEqual(["default", "MyNamespace"]);
    });

    it("should say when the log stopped before the transaction did", async () => {
      // The parser marks the line that lost its exit event. The root is never
      // marked, so reading it there reports every truncated log as whole.
      const summary = await summaryOf({
        children: [node({ subCategory: "Method", isTruncated: true })],
      });

      expect(summary.truncated).toBe(true);
    });

    it("should say when a section of the log was skipped", async () => {
      // The events pair up around the gap, so no node is marked and only the
      // log issue says part of the transaction is missing.
      const summary = await summaryOf({
        children: [node({ subCategory: "Method" })],
        logIssues: [
          {
            summary: "Skipped-Lines",
            description: "*** Skipped 1,000 bytes of detailed log",
            type: "skip",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.truncated).toBe(true);
    });

    it("should say when the log hit the maximum size", async () => {
      const summary = await summaryOf({
        children: [node({ subCategory: "Method" })],
        logIssues: [
          {
            summary: "Max-Size-reached",
            description: "The maximum log size has been reached.",
            type: "skip",
            startTime: 9000,
          },
        ] as LogIssue[],
      });

      expect(summary.truncated).toBe(true);
    });

    it("should call a whole log whole when its issues are not about missing log", async () => {
      const summary = await summaryOf({
        children: [node({ subCategory: "Method" })],
        logIssues: [
          {
            summary: "CPU time exceeded",
            description: "Maximum CPU time limit exceeded",
            type: "error",
            startTime: 8000,
          },
        ] as LogIssue[],
      });

      expect(summary.truncated).toBe(false);
    });

    it("should report every log category and its level", async () => {
      // The levels tie log content to log configuration: what was captured, and
      // what is missing because a category was switched off.
      const summary = await summaryOf({
        debugLevels: [
          { logCategory: "Apex_code", logLevel: "DEBUG" },
          { logCategory: "Db", logLevel: "NONE" },
        ] as any,
      });

      expect(summary.debugLevels).toEqual([
        { logCategory: "Apex_code", level: "DEBUG" },
        { logCategory: "Db", level: "NONE" },
      ]);
    });

    it("should report log issues and count parsing errors", async () => {
      const summary = await summaryOf({
        logIssues: [
          {
            summary: "CPU time exceeded",
            description: "Maximum CPU time limit exceeded",
            type: "error",
            startTime: 8000,
          },
        ] as LogIssue[],
        parsingErrors: ["Unknown log event type: CUSTOM_EVENT"],
      });

      expect(summary.logIssues).toEqual([
        { type: "error", summary: "CPU time exceeded" },
      ]);
      expect(summary.parsingErrorCount).toBe(1);
    });

    it("should drop logIssues, the one occurrence list, when nothing occurred", async () => {
      const summary = await summaryOf();

      expect(summary.logIssues).toBeUndefined();
      // The rest are part of the fixed schema and report their emptiness.
      expect(summary.parsingErrorCount).toBe(0);
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
        governorLimits: governorLimitsOf({ cpuTime: 8000, soqlQueries: 50 }),
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

    it("should not report byNamespace as a limit", async () => {
      const summary = await summaryOf();

      expect(
        summary.governorLimits.map((row: { limit: string }) => row.limit),
      ).not.toContain("byNamespace");
    });
  });

  describe("limitsByNamespace", () => {
    it("should report what each namespace consumed", async () => {
      const summary = await summaryOf({
        governorLimits: governorLimitsOf(
          { soqlQueries: 6, cpuTime: 1500 },
          new Map([
            ["srm_pkg", limitsOf({ soqlQueries: 4, cpuTime: 900 })],
            ["default", limitsOf({ soqlQueries: 2 })],
          ]),
        ),
      });

      expect(summary.limitsByNamespace).toEqual([
        { namespace: "srm_pkg", limit: "soqlQueries", used: 4 },
        { namespace: "srm_pkg", limit: "cpuTime", used: 900 },
        { namespace: "default", limit: "soqlQueries", used: 2 },
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
            subCategory: "Method",
            selfNs: 2_000_000_000,
            children: [
              node({
                type: "SOQL_EXECUTE_BEGIN",
                subCategory: "SOQL",
                selfNs: 1_000_000_000,
              }),
            ],
          }),
          node({
            type: "METHOD_ENTRY",
            subCategory: "Method",
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
