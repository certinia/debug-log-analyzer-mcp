/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import path from "path";

import { getLogSummary, LogSummaryArgs } from "../src/tools/getLogSummary";
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
jest.mock("fs", () => ({
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

jest.mock("path", () => ({
  basename: jest.fn(),
}));

jest.mock("../src/ApexLogParser", () => ({
  parse: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockPath = path as jest.Mocked<typeof path>;
const mockParse = parse as jest.MockedFunction<typeof parse>;

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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue(mockLogContent);
      mockPath.basename.mockReturnValue("test-log.log");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/test-log.log",
      };

      const result = await getLogSummary(args);

      expect(mockFs.access).toHaveBeenCalledWith("/path/to/test-log.log");
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/path/to/test-log.log",
        "utf-8",
      );
      expect(mockPath.basename).toHaveBeenCalledWith("/path/to/test-log.log");
      expect(mockParse).toHaveBeenCalledWith(mockLogContent);

      const parsedResult = toonDecode(result);

      expect(parsedResult.file).toBe("test-log.log");
      expect(parsedResult.size).toBe(15000);
      expect(parsedResult.debugLevels).toEqual([]);
      expect(parsedResult.totalExecutionTime).toBe(12500); // ms
      expect(parsedResult.totalMethods).toBe(3); // 2 METHOD_ENTRY + 1 with subCategory 'Method'
      expect(parsedResult.totalSOQLQueries).toBe(5);
      expect(parsedResult.totalDMLOperations).toBe(3);
      expect(parsedResult.totalSOQLRows).toBe(150);
      expect(parsedResult.totalDMLRows).toBe(25);
      expect(parsedResult.namespaces).toEqual(["default", "MyNamespace"]);
      expect(parsedResult.logIssues).toEqual([]);
      expect(parsedResult.parsingErrors).toBe(0);

      // Governor limits: only those with used > 0 or limit > 0
      expect(parsedResult.governorLimits.cpuTime).toEqual({
        used: 1500,
        limit: 10000,
      });
      expect(parsedResult.governorLimits.soqlQueries).toEqual({
        used: 5,
        limit: 100,
      });
      expect(parsedResult.governorLimits.dmlStatements).toEqual({
        used: 3,
        limit: 150,
      });
    });

    it("should map debugLevels to compact category/level objects", async () => {
      const mockApexLog = createMockApexLog({
        debugLevels: [
          { logCategory: "Apex_code", logLevel: "DEBUG" },
          { logCategory: "System", logLevel: "INFO" },
        ] as any,
      });

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("debug-levels.log");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/debug-levels.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.debugLevels).toEqual([
        { category: "Apex_code", level: "DEBUG" },
        { category: "System", level: "INFO" },
      ]);
    });

    it("should handle logs with different namespaces", async () => {
      const mockApexLog = createMockApexLog({
        namespaces: ["default", "CustomApp", "ThirdParty"],
      });

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("namespace-test.log");
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
      expect(parsedResult.file).toBe("namespace-test.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("error-log.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("nested-methods.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("empty-log.log");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/empty-log.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.totalExecutionTime).toBe(0);
      expect(parsedResult.totalMethods).toBe(0);
      expect(parsedResult.totalSOQLQueries).toBe(0);
      expect(parsedResult.totalDMLOperations).toBe(0);
      expect(parsedResult.totalSOQLRows).toBe(0);
      expect(parsedResult.totalDMLRows).toBe(0);
      // All limits are 0/0, so governorLimits should be empty
      expect(parsedResult.governorLimits).toEqual({});
    });

    it("should handle different file paths and extensions", async () => {
      const testCases = [
        {
          path: "/Users/test/apex-debug-123.log",
          expected: "apex-debug-123.log",
        },
        { path: "C:\\Logs\\production.log", expected: "production.log" },
        { path: "/var/logs/debug-output.txt", expected: "debug-output.txt" },
        { path: "simple.log", expected: "simple.log" },
      ];

      for (const testCase of testCases) {
        const mockApexLog = createMockApexLog();

        mockFs.access.mockResolvedValue(undefined);
        mockFs.readFile.mockResolvedValue("mock log content");
        mockPath.basename.mockReturnValue(testCase.expected);
        mockParse.mockReturnValue(mockApexLog);

        const args: LogSummaryArgs = {
          logFilePath: testCase.path,
        };

        const result = await getLogSummary(args);
        const parsedResult = toonDecode(result);

        expect(parsedResult.file).toBe(testCase.expected);
        expect(mockPath.basename).toHaveBeenCalledWith(testCase.path);
      }
    });
  });

  describe("error handling", () => {
    it("should throw an error when log file does not exist", async () => {
      const fileNotFoundError = new Error("ENOENT: no such file or directory");
      mockFs.access.mockRejectedValue(fileNotFoundError);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/nonexistent.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow(
        "Log file not found: /path/to/nonexistent.log",
      );

      expect(mockFs.access).toHaveBeenCalledWith("/path/to/nonexistent.log");
      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should throw an error when file access check fails for other reasons", async () => {
      const permissionError = new Error("EACCES: permission denied");
      mockFs.access.mockRejectedValue(permissionError);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/restricted.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow(
        "Log file not found: /path/to/restricted.log",
      );
    });

    it("should propagate file read errors", async () => {
      mockFs.access.mockResolvedValue(undefined);
      const readError = new Error("Failed to read file");
      mockFs.readFile.mockRejectedValue(readError);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/unreadable.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow("Failed to read file");

      expect(mockFs.access).toHaveBeenCalledWith("/path/to/unreadable.log");
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/path/to/unreadable.log",
        "utf-8",
      );
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should propagate parsing errors", async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("invalid log content");
      const parseError = new Error("Failed to parse log");
      mockParse.mockImplementation(() => {
        throw parseError;
      });

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/corrupted.log",
      };

      await expect(getLogSummary(args)).rejects.toThrow("Failed to parse log");

      expect(mockFs.access).toHaveBeenCalledWith("/path/to/corrupted.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("edge-case.log");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/edge-case.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.namespaces).toEqual([]);
      expect(parsedResult.logIssues).toEqual([]);
      expect(parsedResult.parsingErrors).toBe(0);
      expect(parsedResult.file).toBe("edge-case.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("method-counting.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("deep-nested.log");
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("non-methods.log");
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
    it("should include all governor limits with used > 0 or limit > 0", async () => {
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("governor-limits.log");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/governor-limits.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      // All limits with used > 0 or limit > 0 should be included
      expect(parsedResult.governorLimits.cpuTime).toEqual({
        used: 8000,
        limit: 10000,
      });
      expect(parsedResult.governorLimits.heapSize).toEqual({
        used: 5000000,
        limit: 6000000,
      });
      expect(parsedResult.governorLimits.soqlQueries).toEqual({
        used: 50,
        limit: 100,
      });
      expect(parsedResult.governorLimits.dmlStatements).toEqual({
        used: 25,
        limit: 150,
      });
      expect(parsedResult.governorLimits.queryRows).toEqual({
        used: 2500,
        limit: 50000,
      });
      expect(parsedResult.governorLimits.callouts).toEqual({
        used: 3,
        limit: 100,
      });
      expect(parsedResult.governorLimits.dmlRows).toEqual({
        used: 500,
        limit: 10000,
      });
      // mobileApexPushCalls has used: 0, limit: 10 — included since limit > 0
      expect(parsedResult.governorLimits.mobileApexPushCalls).toEqual({
        used: 0,
        limit: 10,
      });
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

      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("mock log content");
      mockPath.basename.mockReturnValue("max-limits.log");
      mockParse.mockReturnValue(mockApexLog);

      const args: LogSummaryArgs = {
        logFilePath: "/path/to/max-limits.log",
      };

      const result = await getLogSummary(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.governorLimits.cpuTime.used).toBe(10000);
      expect(parsedResult.governorLimits.cpuTime.limit).toBe(10000);
      expect(parsedResult.governorLimits.heapSize.used).toBe(6000000);
      expect(parsedResult.governorLimits.heapSize.limit).toBe(6000000);
      expect(parsedResult.governorLimits.soqlQueries.used).toBe(100);
      expect(parsedResult.governorLimits.soqlQueries.limit).toBe(100);
      expect(parsedResult.governorLimits.dmlStatements.used).toBe(150);
      expect(parsedResult.governorLimits.dmlStatements.limit).toBe(150);
    });
  });
});
