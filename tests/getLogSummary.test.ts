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

// Helper function to create a mock LogLine
const createMockLogLine = (
  type: string,
  subCategory?: string,
  children: LogLine[] = [],
): LogLine =>
  ({
    type: type as any,
    subCategory: subCategory as any,
    children,
    logParser: {} as ApexLogParser,
    parent: null,
    logLine: "",
    text: "",
    lineNumber: null,
    logCategory: null,
    acceptsText: false,
    isExit: false,
    textData: "",
    timestamp: 0,
    dmlRowCount: { total: 0, self: 0 },
    soqlRowCount: { total: 0, self: 0 },
    soqlCount: { total: 0, self: 0 },
    dmlCount: { total: 0, self: 0 },
    soslCount: { total: 0, self: 0 },
    soslRowCount: { total: 0, self: 0 },
    cpuSelfTime: 0,
    cpuTotalTime: 0,
    parseTimestamp: () => 0,
    parseLineNumber: () => null,
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

  const createMockApexLog = (overrides: Partial<ApexLog> = {}): ApexLog => {
    const mockGovernorLimits: GovernorLimits = {
      soqlQueries: { used: 5, limit: 100 },
      soslQueries: { used: 1, limit: 20 },
      queryRows: { used: 150, limit: 50000 },
      dmlStatements: { used: 3, limit: 150 },
      publishImmediateDml: { used: 0, limit: 10 },
      dmlRows: { used: 25, limit: 10000 },
      cpuTime: { used: 1500, limit: 10000 },
      heapSize: { used: 2048, limit: 6000000 },
      callouts: { used: 0, limit: 100 },
      emailInvocations: { used: 0, limit: 10 },
      futureCalls: { used: 0, limit: 50 },
      queueableJobsAddedToQueue: { used: 0, limit: 50 },
      mobileApexPushCalls: { used: 0, limit: 10 },
      byNamespace: new Map<string, Limits>(),
    };

    const mockLogIssues: LogIssue[] = [];
    const mockParsingErrors: string[] = [];

    // Create mock log lines with METHOD_ENTRY types for counting
    const mockChildren: LogLine[] = [
      createMockLogLine("METHOD_ENTRY", undefined, [
        createMockLogLine("METHOD_ENTRY"),
        createMockLogLine("STATEMENT_EXECUTE"),
      ]),
      createMockLogLine("SOQL_EXECUTE_BEGIN", "Method"),
      createMockLogLine("DML_BEGIN"),
    ];

    // Create a proper mock ApexLog by extending the base structure
    const baseMockApexLog = {
      // ApexLog specific properties
      type: null,
      text: "LOG_ROOT",
      timestamp: 0,
      exitStamp: 12500,
      size: 15000,
      debugLevels: [],
      namespaces: ["default", "MyNamespace"],
      logIssues: mockLogIssues,
      parsingErrors: mockParsingErrors,
      governorLimits: mockGovernorLimits,
      executionEndTime: 12500,

      // Method properties (ApexLog extends Method)
      isTruncated: false,
      exitTypes: ["EXECUTION_FINISHED"],

      // TimedNode properties (Method extends TimedNode)
      subCategory: "Code Unit" as any,
      cpuType: "" as any,

      // LogLine properties (TimedNode extends LogLine)
      logParser: {} as ApexLogParser,
      parent: null,
      children: mockChildren,
      logLine: "",
      lineNumber: null,
      logCategory: null,
      acceptsText: false,
      isExit: false,
      textData: "",

      // Counting properties
      duration: { total: 12500000000, self: 12500000000 },
      dmlRowCount: { total: 25, self: 25 },
      soqlRowCount: { total: 150, self: 150 },
      soqlCount: { total: 5, self: 5 },
      dmlCount: { total: 3, self: 3 },
      soslCount: { total: 1, self: 1 },
      soslRowCount: { total: 10, self: 10 },
      cpuSelfTime: 1500,
      cpuTotalTime: 1500,

      // Methods that might be called
      parseTimestamp: () => 0,
      parseLineNumber: () => null,
      setTimes: () => {},
      addChild: () => {},
      recalculateDurations: () => {},
    };

    const defaultApexLog = {
      ...baseMockApexLog,
      ...overrides,
    } as unknown as ApexLog;

    return defaultApexLog;
  };

  describe("successful log summary generation", () => {
    it("should generate a complete log summary with valid log data", async () => {
      const mockLogContent = "mock log content";
      const mockApexLog = createMockApexLog();

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue(mockLogContent);
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/test-log.log",
      };

      const result = await getLogSummary(args);

      expect(mockFs.stat).toHaveBeenCalledWith("/path/to/test-log.log", { bigint: true });
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/path/to/test-log.log",
        "utf-8",
      );
      expect(mockParse).toHaveBeenCalledWith(mockLogContent);

      const parsedResult = toonDecode(result);

      expect(parsedResult.size).toBe(15000);
      expect(parsedResult.totalExecutionTime).toBe(12500); // ms
      expect(parsedResult.totalMethods).toBe(3); // 2 METHOD_ENTRY + 1 with subCategory 'Method'
      expect(parsedResult.totalSOQLQueries).toBe(5);
      expect(parsedResult.totalDMLOperations).toBe(3);
      expect(parsedResult.totalSOQLRows).toBe(150);
      expect(parsedResult.totalDMLRows).toBe(25);
      expect(parsedResult.namespaces).toEqual(["default", "MyNamespace"]);
      // The only omission: the log contained no issues, and an absent list says so.
      expect(parsedResult.logIssues).toBeUndefined();
      expect(parsedResult.parsingErrors).toBe(0);

      // Every limit is a row, whether or not anything was spent against it.
      expect(parsedResult.governorLimits).toHaveLength(13);
      expect(parsedResult.governorLimits).toContainEqual({
        name: "cpuTime",
        used: 1500,
        limit: 10000,
      });
      expect(parsedResult.governorLimits).toContainEqual({
        name: "dmlStatements",
        used: 3,
        limit: 150,
      });
      expect(parsedResult.governorLimits).toContainEqual({
        name: "callouts",
        used: 0,
        limit: 100,
      });
    });

    it("should report every log category and its level", async () => {
      const mockApexLog = createMockApexLog({
        debugLevels: [
          { logCategory: "Apex_code", logLevel: "DEBUG" },
          { logCategory: "System", logLevel: "INFO" },
          { logCategory: "Callout", logLevel: "NONE" },
          { logCategory: "Workflow", logLevel: "NONE" },
        ] as any,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/debug-levels.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // The levels tie log content to log configuration: what was captured, and
      // what is missing because a category was switched off.
      expect(parsedResult.debugLevels).toEqual([
        { category: "Apex_code", level: "DEBUG" },
        { category: "System", level: "INFO" },
        { category: "Callout", level: "NONE" },
        { category: "Workflow", level: "NONE" },
      ]);
    });

    it("should handle logs with different namespaces", async () => {
      const mockApexLog = createMockApexLog({
        namespaces: ["default", "CustomApp", "ThirdParty"],
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/namespace-test.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.namespaces).toEqual([
        "default",
        "CustomApp",
        "ThirdParty",
      ]);
    });

    it("should include log issues as array of {type, summary} objects", async () => {
      const mockLogIssues: LogIssue[] = [
        {
          summary: "CPU time exceeded",
          description: "Maximum CPU time limit exceeded",
          type: "error",
          startTime: 8000,
        },
      ];

      const mockApexLog = createMockApexLog({
        logIssues: mockLogIssues,
        parsingErrors: ["Unknown log event type: CUSTOM_EVENT"],
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/error-log.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.logIssues).toEqual([
        { type: "error", summary: "CPU time exceeded" },
      ]);
      expect(parsedResult.parsingErrors).toBe(1);
    });

    it("should count methods correctly with nested structures", async () => {
      const mockChildren: LogLine[] = [
        createMockLogLine("METHOD_ENTRY", undefined, [
          createMockLogLine("METHOD_ENTRY", undefined, [
            createMockLogLine("METHOD_ENTRY"),
          ]),
        ]),
        createMockLogLine("SOQL_EXECUTE_BEGIN", "Method", [
          createMockLogLine("CONSTRUCTOR_ENTRY", "Method"),
        ]),
        createMockLogLine("SOME_OTHER_EVENT"),
      ];

      const mockApexLog = createMockApexLog({
        children: mockChildren,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/nested-methods.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // Should count: 3 METHOD_ENTRY + 1 with subCategory 'Method' + 1 CONSTRUCTOR_ENTRY with subCategory 'Method' = 5
      expect(parsedResult.totalMethods).toBe(5);
    });

    it("should handle logs with zero values", async () => {
      const emptyGovernorLimits: GovernorLimits = {
        soqlQueries: { used: 0, limit: 0 },
        soslQueries: { used: 0, limit: 0 },
        queryRows: { used: 0, limit: 0 },
        dmlStatements: { used: 0, limit: 0 },
        publishImmediateDml: { used: 0, limit: 0 },
        dmlRows: { used: 0, limit: 0 },
        cpuTime: { used: 0, limit: 0 },
        heapSize: { used: 0, limit: 0 },
        callouts: { used: 0, limit: 0 },
        emailInvocations: { used: 0, limit: 0 },
        futureCalls: { used: 0, limit: 0 },
        queueableJobsAddedToQueue: { used: 0, limit: 0 },
        mobileApexPushCalls: { used: 0, limit: 0 },
        byNamespace: new Map<string, Limits>(),
      };

      const mockApexLog = createMockApexLog({
        duration: { total: 0, self: 0 },
        soqlCount: { total: 0, self: 0 },
        dmlCount: { total: 0, self: 0 },
        soqlRowCount: { total: 0, self: 0 },
        dmlRowCount: { total: 0, self: 0 },
        governorLimits: emptyGovernorLimits,
        namespaces: ["default"],
        children: [],
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/empty-log.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // "Nothing ran" is an answer, and only a reported zero gives it. An absent
      // counter cannot be told apart from one the parser never populated.
      expect(parsedResult.totalExecutionTime).toBe(0);
      expect(parsedResult.totalMethods).toBe(0);
      expect(parsedResult.totalSOQLQueries).toBe(0);
      expect(parsedResult.totalDMLOperations).toBe(0);
      expect(parsedResult.totalSOQLRows).toBe(0);
      expect(parsedResult.totalDMLRows).toBe(0);
      expect(parsedResult.governorLimits).toHaveLength(13);
      expect(parsedResult.governorLimits).toContainEqual({
        name: "dmlStatements",
        used: 0,
        limit: 0,
      });
    });

    it("should not echo the log file path back to the caller", async () => {
      const paths = [
        "/Users/test/apex-debug-123.log",
        "C:\\Logs\\production.log",
        "/var/logs/debug-output.txt",
        "simple.log",
      ];

      for (const logFilePath of paths) {
        mockFs.stat.mockResolvedValue(mockStats);
        mockFs.readFile.mockResolvedValue("mock log content");
        mockParse.mockReturnValue(createMockApexLog());

        const result = await getLogSummary({ logFilePath });
        const parsedResult = toonDecode(result);

        // The caller supplied the path, so repeating it back only costs tokens.
        expect(parsedResult.file).toBeUndefined();
        expect(mockFs.readFile).toHaveBeenCalledWith(logFilePath, "utf-8");
      }
    });
  });

  describe("error handling", () => {
    it("should throw an error when log file does not exist", async () => {
      const fileNotFoundError = new Error("ENOENT: no such file or directory");
      mockFs.stat.mockRejectedValue(fileNotFoundError);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/nonexistent.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow(
        "Log file not found: /path/to/nonexistent.log",
      );

      expect(mockFs.stat).toHaveBeenCalledWith("/path/to/nonexistent.log", { bigint: true });
      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should throw an error when file access check fails for other reasons", async () => {
      const permissionError = new Error("EACCES: permission denied");
      mockFs.stat.mockRejectedValue(permissionError);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/restricted.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow(
        "Log file not found: /path/to/restricted.log",
      );
    });

    it("should propagate file read errors", async () => {
      mockFs.stat.mockResolvedValue(mockStats);
      const readError = new Error("Failed to read file");
      mockFs.readFile.mockRejectedValue(readError);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/unreadable.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow("Failed to read file");

      expect(mockFs.stat).toHaveBeenCalledWith("/path/to/unreadable.log", { bigint: true });
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/path/to/unreadable.log",
        "utf-8",
      );
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should propagate parsing errors", async () => {
      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("invalid log content");
      const parseError = new Error("Failed to parse log");
      mockParse.mockImplementation(() => {
        throw parseError;
      });

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/corrupted.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow("Failed to parse log");

      expect(mockFs.stat).toHaveBeenCalledWith("/path/to/corrupted.log", { bigint: true });
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/path/to/corrupted.log",
        "utf-8",
      );
      expect(mockParse).toHaveBeenCalledWith("invalid log content");
    });

    it("should handle undefined or null properties gracefully", async () => {
      // Create an ApexLog with some undefined/null properties to test resilience
      const mockApexLog = createMockApexLog({
        namespaces: [], // empty namespaces array
        logIssues: [], // empty log issues
        parsingErrors: [], // empty parsing errors
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/edge-case.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // `logIssues` is the one occurrence list, so it is the one key that goes
      // away. The rest are part of the fixed schema and report their emptiness.
      expect(parsedResult.logIssues).toBeUndefined();
      expect(parsedResult.namespaces).toEqual([]);
      expect(parsedResult.parsingErrors).toBe(0);
    });
  });

  describe("method counting functionality", () => {
    it("should count only METHOD_ENTRY types and subCategory Method nodes", async () => {
      const mockChildren: LogLine[] = [
        createMockLogLine("METHOD_ENTRY"),
        createMockLogLine("CONSTRUCTOR_ENTRY"),
        createMockLogLine("SYSTEM_METHOD_ENTRY", "Method"),
        createMockLogLine("SOQL_EXECUTE_BEGIN", "SOQL"),
        createMockLogLine("DML_BEGIN", "DML"),
        createMockLogLine("USER_DEBUG"),
      ];

      const mockApexLog = createMockApexLog({
        children: mockChildren,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/method-counting.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // Should count: 1 METHOD_ENTRY + 1 with subCategory 'Method' = 2
      expect(parsedResult.totalMethods).toBe(2);
    });

    it("should handle deeply nested method structures", async () => {
      const createNestedStructure = (depth: number): LogLine => {
        if (depth === 0) {
          return createMockLogLine("METHOD_ENTRY");
        }
        return createMockLogLine("METHOD_ENTRY", undefined, [
          createNestedStructure(depth - 1),
        ]);
      };

      const mockChildren: LogLine[] = [
        createNestedStructure(5), // Creates a 6-level deep nested structure
        createMockLogLine("SOME_OTHER_EVENT", "Method", [
          createMockLogLine("METHOD_ENTRY"),
        ]),
      ];

      const mockApexLog = createMockApexLog({
        children: mockChildren,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/deep-nested.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // Should count: 6 METHOD_ENTRY nodes + 1 with subCategory 'Method' + 1 nested METHOD_ENTRY = 8
      expect(parsedResult.totalMethods).toBe(8);
    });

    it("should not count non-method events", async () => {
      const mockChildren: LogLine[] = [
        createMockLogLine("EXECUTION_STARTED"),
        createMockLogLine("EXECUTION_FINISHED"),
        createMockLogLine("USER_DEBUG"),
        createMockLogLine("HEAP_ALLOCATE"),
        createMockLogLine("STATEMENT_EXECUTE"),
      ];

      const mockApexLog = createMockApexLog({
        children: mockChildren,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/non-methods.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.totalMethods).toBe(0);
    });
  });

  describe("governor limits handling", () => {
    it("should report every governor limit as a row", async () => {
      const customGovernorLimits: GovernorLimits = {
        soqlQueries: { used: 50, limit: 100 },
        soslQueries: { used: 5, limit: 20 },
        queryRows: { used: 2500, limit: 50000 },
        dmlStatements: { used: 25, limit: 150 },
        publishImmediateDml: { used: 2, limit: 10 },
        dmlRows: { used: 500, limit: 10000 },
        cpuTime: { used: 8000, limit: 10000 },
        heapSize: { used: 5000000, limit: 6000000 },
        callouts: { used: 3, limit: 100 },
        emailInvocations: { used: 1, limit: 10 },
        futureCalls: { used: 2, limit: 50 },
        queueableJobsAddedToQueue: { used: 1, limit: 50 },
        mobileApexPushCalls: { used: 0, limit: 10 },
        byNamespace: new Map<string, Limits>(),
      };

      const mockApexLog = createMockApexLog({
        governorLimits: customGovernorLimits,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/governor-limits.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // The whole fixed set, flattened to rows that share three keys so TOON can
      // emit one header and one line per limit.
      expect(parsedResult.governorLimits).toEqual([
        { name: "soqlQueries", used: 50, limit: 100 },
        { name: "soslQueries", used: 5, limit: 20 },
        { name: "queryRows", used: 2500, limit: 50000 },
        { name: "dmlStatements", used: 25, limit: 150 },
        { name: "publishImmediateDml", used: 2, limit: 10 },
        { name: "dmlRows", used: 500, limit: 10000 },
        { name: "cpuTime", used: 8000, limit: 10000 },
        { name: "heapSize", used: 5000000, limit: 6000000 },
        { name: "callouts", used: 3, limit: 100 },
        { name: "emailInvocations", used: 1, limit: 10 },
        { name: "futureCalls", used: 2, limit: 50 },
        { name: "queueableJobsAddedToQueue", used: 1, limit: 50 },
        // Nothing was spent against this one, and the row says exactly that.
        { name: "mobileApexPushCalls", used: 0, limit: 10 },
      ]);
    });

    it("should handle maximum governor limit values", async () => {
      const maxGovernorLimits: GovernorLimits = {
        soqlQueries: { used: 100, limit: 100 },
        soslQueries: { used: 20, limit: 20 },
        queryRows: { used: 50000, limit: 50000 },
        dmlStatements: { used: 150, limit: 150 },
        publishImmediateDml: { used: 10, limit: 10 },
        dmlRows: { used: 10000, limit: 10000 },
        cpuTime: { used: 10000, limit: 10000 },
        heapSize: { used: 6000000, limit: 6000000 },
        callouts: { used: 100, limit: 100 },
        emailInvocations: { used: 10, limit: 10 },
        futureCalls: { used: 50, limit: 50 },
        queueableJobsAddedToQueue: { used: 50, limit: 50 },
        mobileApexPushCalls: { used: 10, limit: 10 },
        byNamespace: new Map<string, Limits>(),
      };

      const mockApexLog = createMockApexLog({
        governorLimits: maxGovernorLimits,
      });

      mockFs.stat.mockResolvedValue(mockStats);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/max-limits.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // Every limit is at its ceiling, so `used` and `limit` match on every row.
      expect(parsedResult.governorLimits).toHaveLength(13);
      for (const row of parsedResult.governorLimits) {
        expect(row.used).toBe(row.limit);
      }
      expect(parsedResult.governorLimits).toContainEqual({
        name: "cpuTime",
        used: 10000,
        limit: 10000,
      });
      expect(parsedResult.governorLimits).toContainEqual({
        name: "heapSize",
        used: 6000000,
        limit: 6000000,
      });
    });
  });
});
