/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type Stats } from "fs";
import { clearApexLogCache } from "../src/tools/apexLogSource";
import {
  analyzeLogPerformance,
  extractMethods,
  AnalyzeLogArgs,
  LogAnalysisResult,
  analyzeLogPerformanceToolConfig,
  analyzeLogPerformanceInputSchema,
} from "../src/tools/analyzeLogPerformance";
import { parse } from "../src/ApexLogParser";
import { decode } from "@toon-format/toon";

// Mock file system operations
jest.mock("fs", () => ({
  promises: {
    stat: jest.fn(),
    readFile: jest.fn(),
  },
}));

jest.mock("../src/ApexLogParser", () => ({
  parse: jest.fn(),
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedParse = parse as jest.MockedFunction<typeof parse>;
const mockStats = { mtimeMs: 1, size: 1 } as Stats;

describe("analyzeLogPerformance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The suites reuse one path with different content, which the cache would
    // otherwise hide.
    clearApexLogCache();
  });

  describe("Tool Configuration", () => {
    it("should have correct tool configuration", () => {
      expect(analyzeLogPerformanceToolConfig.description).toContain(
        "Rank methods in an Apex debug log by self-execution time",
      );
      expect(analyzeLogPerformanceInputSchema.logFilePath).toBeDefined();
      expect(analyzeLogPerformanceInputSchema.topMethods).toBeDefined();
      expect(analyzeLogPerformanceInputSchema.minDuration).toBeDefined();
      expect(analyzeLogPerformanceInputSchema.namespace).toBeDefined();
    });

    it("should annotate only the hints that carry meaning for a read-only tool", () => {
      expect(analyzeLogPerformanceToolConfig.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
    });
  });

  describe("File Validation", () => {
    it("should throw error when file does not exist", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/nonexistent/file.log" };
      mockedFs.stat.mockRejectedValue(new Error("File not found"));

      await expect(analyzeLogPerformance(args)).rejects.toThrow(
        "Log file not found: /nonexistent/file.log",
      );

      expect(mockedFs.stat).toHaveBeenCalledWith("/nonexistent/file.log");
    });

    it("should proceed when file exists", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/valid/file.log" };
      const mockLogContent = "mock log content";
      const mockApexLog = createMockApexLog();

      mockedFs.stat.mockResolvedValue(mockStats);
      mockedFs.readFile.mockResolvedValue(mockLogContent);
      mockedParse.mockReturnValue(mockApexLog);

      const result = await analyzeLogPerformance(args);

      expect(mockedFs.stat).toHaveBeenCalledWith("/valid/file.log");
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        "/valid/file.log",
        "utf-8",
      );
      expect(mockedParse).toHaveBeenCalledWith(mockLogContent);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
    });
  });

  describe("Basic Functionality", () => {
    it("should analyze log with default parameters", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.totalMethods).toBe(3);
      expect(parsedResult.totalExecutionTime).toBe(1000); // 1s in ms
      expect(parsedResult.slowestMethods).toHaveLength(3);
      expect(parsedResult.slowestMethods[0].name).toBe("SlowMethod");
      expect(parsedResult.recommendations).toBeInstanceOf(Array);
    });

    it("should return durations in milliseconds", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.slowestMethods[0].duration).toBe(500); // 500ms
      expect(parsedResult.slowestMethods[0].selfDuration).toBe(500); // 500ms
      expect(parsedResult.slowestMethods[1].duration).toBe(400); // 400ms
      expect(parsedResult.slowestMethods[2].duration).toBe(100); // 100ms
    });

    it("should limit results with topMethods parameter", async () => {
      const args: AnalyzeLogArgs = {
        logFilePath: "/test/file.log",
        topMethods: 2,
      };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.slowestMethods).toHaveLength(2);
      expect(parsedResult.slowestMethods[0].name).toBe("SlowMethod");
      expect(parsedResult.slowestMethods[1].name).toBe("MediumMethod");
    });

    it("should filter by minimum duration in milliseconds", async () => {
      const args: AnalyzeLogArgs = {
        logFilePath: "/test/file.log",
        minDuration: 300, // 300ms
      };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.totalMethods).toBe(2); // Only SlowMethod and MediumMethod
      expect(parsedResult.slowestMethods).toHaveLength(2);
      expect(
        parsedResult.slowestMethods.every((method) => method.duration >= 300),
      ).toBe(true);
    });

    it("should filter by namespace", async () => {
      const args: AnalyzeLogArgs = {
        logFilePath: "/test/file.log",
        namespace: "CustomNamespace",
      };
      const mockApexLog = createMockApexLogWithNamespaces();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.totalMethods).toBe(1);
      expect(parsedResult.slowestMethods).toHaveLength(1);
      expect(parsedResult.slowestMethods[0].namespace).toBe("CustomNamespace");
    });
  });

  describe("extractMethods function", () => {
    it("should extract methods from log correctly", () => {
      const mockApexLog = createMockApexLog();
      const methods = extractMethods(mockApexLog, 0);

      expect(methods).toHaveLength(3);
      expect(methods[0].name).toBe("SlowMethod");
      expect(methods[0].duration).toBe(500000000);
      expect(methods[0].selfPercentage).toBe(50);
      expect(methods[0].dmlCount).toBe(5);
      expect(methods[0].soqlCount).toBe(10);
    });

    it("should filter methods by minimum duration in nanoseconds", () => {
      const mockApexLog = createMockApexLog();
      const methods = extractMethods(mockApexLog, 300000000); // 300ms in ns

      expect(methods).toHaveLength(2);
      expect(methods.every((method) => method.duration >= 300000000)).toBe(
        true,
      );
    });

    it("should filter methods by namespace", () => {
      const mockApexLog = createMockApexLogWithNamespaces();
      const methods = extractMethods(mockApexLog, 0, "CustomNamespace");

      expect(methods).toHaveLength(1);
      expect(methods[0].namespace).toBe("CustomNamespace");
    });

    it("should handle methods with null or undefined properties", () => {
      const mockApexLog = createMockApexLogWithNullValues();
      const methods = extractMethods(mockApexLog, 0);

      expect(methods).toHaveLength(1);
      expect(methods[0].name).toBe("Unknown Method");
      expect(methods[0].namespace).toBe("default");
      expect(methods[0].lineNumber).toBeNull();
    });

    it("should calculate self percentages correctly", () => {
      const mockApexLog = createMockApexLog();
      const methods = extractMethods(mockApexLog, 0);

      expect(methods[0].selfPercentage).toBe(50); // 500000000 / 1000000000 * 100
      expect(methods[1].selfPercentage).toBe(40); // 400000000 / 1000000000 * 100
      expect(methods[2].selfPercentage).toBe(10); // 100000000 / 1000000000 * 100
    });

    it("should extract thrownCount and SOSL metrics from log lines", () => {
      const methodWithSOSL = createMockLogLine(
        "SOSLMethod",
        500000000,
        500000000,
        "default",
        1,
        0, // dmlCount
        0, // soqlCount
        0, // dmlRows
        0, // soqlRows
        5, // soslCount
        250, // soslRows
        3, // totalThrownCount
      );

      const mockApexLog = {
        duration: { total: 1000000000, self: 0 },
        children: [methodWithSOSL],
        type: "EXECUTION_STARTED",
        text: "Root",
        namespace: "default",
        lineNumber: null,
        dmlCount: { total: 0, self: 0 },
        soqlCount: { total: 0, self: 0 },
        dmlRowCount: { total: 0, self: 0 },
        soqlRowCount: { total: 0, self: 0 },
      };

      const methods = extractMethods(mockApexLog as any, 0);

      expect(methods).toHaveLength(1);
      expect(methods[0].thrownCount).toBe(3);
      expect(methods[0].soslCount).toBe(5);
      expect(methods[0].soslRows).toBe(250);
    });

    it("should handle zero total time", () => {
      const mockApexLog = createMockApexLogWithZeroTotalTime();
      const methods = extractMethods(mockApexLog, 0);

      expect(methods.every((method) => method.selfPercentage === 0)).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty log gracefully", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createEmptyMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      // "No methods were found" is a result, not an absence of one.
      expect(parsedResult.totalMethods).toBe(0);
      expect(parsedResult.slowestMethods).toEqual([]);
    });

    it("should handle log with no matching methods after filtering", async () => {
      const args: AnalyzeLogArgs = {
        logFilePath: "/test/file.log",
        namespace: "NonExistentNamespace",
      };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      // The namespace matched nothing, and the empty table is how the caller
      // learns that rather than guessing at a missing key.
      expect(parsedResult.totalMethods).toBe(0);
      expect(parsedResult.slowestMethods).toEqual([]);
    });

    it("should handle parsing errors gracefully", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };

      mockedFs.stat.mockResolvedValue(mockStats);
      mockedFs.readFile.mockResolvedValue("invalid log content");
      mockedParse.mockImplementation(() => {
        throw new Error("Parsing failed");
      });

      await expect(analyzeLogPerformance(args)).rejects.toThrow(
        "Parsing failed",
      );
    });

    it("should handle file read errors", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };

      mockedFs.stat.mockResolvedValue(mockStats);
      mockedFs.readFile.mockRejectedValue(new Error("Permission denied"));

      await expect(analyzeLogPerformance(args)).rejects.toThrow(
        "Permission denied",
      );
    });
  });

  describe("Interface Contracts", () => {
    it("should return SlowMethod objects with correct structure", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      const method = parsedResult.slowestMethods[0];
      expect(typeof method.name).toBe("string");
      expect(typeof method.duration).toBe("number");
      expect(typeof method.selfDuration).toBe("number");
      expect(typeof method.dmlCount).toBe("number");
      expect(typeof method.soqlCount).toBe("number");
      expect(typeof method.dmlRows).toBe("number");
      expect(typeof method.soqlRows).toBe("number");
      expect(typeof method.selfPercentage).toBe("number");
      expect(["number", "string", "object"]).toContain(
        typeof method.lineNumber,
      );
      // The column set is fixed, so a zero SOSL count reads as "none ran" rather
      // than "not measured", and the shape is the same on every call.
      expect(typeof method.namespace).toBe("string");
      expect(typeof method.thrownCount).toBe("number");
      expect(typeof method.soslCount).toBe("number");
      expect(typeof method.soslRows).toBe("number");
    });

    it("should report the namespace of every method", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };

      setupMocksForSuccess(createMockApexLogWithNamespaces());

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(
        parsedResult.slowestMethods.map((method) => method.namespace),
      ).toEqual(["default", "CustomNamespace"]);
    });

    it("should return LogAnalysisResult with correct structure", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(typeof parsedResult.totalMethods).toBe("number");
      expect(typeof parsedResult.totalExecutionTime).toBe("number");
      expect(typeof parsedResult.topMethodsSelfPercentage).toBe("number");
      expect(Array.isArray(parsedResult.slowestMethods)).toBe(true);
      expect(Array.isArray(parsedResult.recommendations)).toBe(true);
    });

    it("should report what share of the run the returned methods account for", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };

      setupMocksForSuccess(createMockApexLog());

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      // The one thing the table cannot say for itself: whether the cost is
      // concentrated in these methods or spread across the rest of the run.
      expect(parsedResult.topMethodsSelfPercentage).toBe(
        parsedResult.slowestMethods.reduce(
          (total: number, method: { selfPercentage: number }) =>
            total + method.selfPercentage,
          0,
        ),
      );
    });

    it("should not restate the table as a prose summary", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLog();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      // The counts, the worst method and its duration are all already columns, so
      // a sentence repeating them is pure duplication.
      expect(parsedResult.summary).toBeUndefined();
    });
  });

  describe("Recommendations Generation", () => {
    it("should generate SOQL query recommendations", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLogWithHighSOQL();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.recommendations).toEqual([
        "HighSOQLMethod: many SOQL queries. Bulkify or cache.",
      ]);
    });

    it("should generate DML recommendations", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLogWithHighDML();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.recommendations).toEqual([
        "HighDMLMethod: many DML operations. Bulkify them.",
      ]);
    });

    it("should generate SOQL rows recommendations", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLogWithHighSOQLRows();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.recommendations).toEqual([
        "HighRowsMethod: high SOQL row count. Add WHERE clauses or paginate.",
      ]);
    });

    it("should generate high percentage recommendations", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLogWithHighPercentage();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      // The percentage that triggered this is already a column on the method's row,
      // so the advice names the lever and leaves the figure out.
      expect(parsedResult.recommendations).toEqual([
        "HighPercentageMethod: dominates self time. Check whether it can be made faster, and how often it is called.",
      ]);
    });

    it("should generate SOSL search recommendations", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLogWithHighSOSL();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.recommendations).toEqual([
        "HighSOSLMethod: many SOSL searches. Reduce or cache them.",
      ]);
    });

    it("should omit recommendations entirely when nothing stands out", async () => {
      const args: AnalyzeLogArgs = { logFilePath: "/test/file.log" };
      const mockApexLog = createMockApexLogWithGoodPerformance();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      // An "all good" sentence costs tokens to say what an absent field already says.
      expect(parsedResult.recommendations).toBeUndefined();
    });

    it("should only analyze top 3 methods for recommendations", async () => {
      const args: AnalyzeLogArgs = {
        logFilePath: "/test/file.log",
        topMethods: 10,
      };
      const mockApexLog = createMockApexLogWithManyMethods();

      setupMocksForSuccess(mockApexLog);

      const result = await analyzeLogPerformance(args);
      const parsedResult = toonDecode(result);

      const mentionsMethod4 = parsedResult.recommendations.some((rec) =>
        rec.includes("Method4"),
      );
      expect(mentionsMethod4).toBe(false);
    });
  });

  // Helper function for decoding TOON-formatted data
  function toonDecode(result: any): LogAnalysisResult {
    return decode(result.content[0].text) as unknown as LogAnalysisResult;
  }

  // Helper functions for creating mock data
  function setupMocksForSuccess(mockApexLog: any): void {
    mockedFs.stat.mockResolvedValue(mockStats);
    mockedFs.readFile.mockResolvedValue("mock log content");
    mockedParse.mockReturnValue(mockApexLog);
  }

  function createMockLogLine(
    name: string,
    duration: number,
    selfDuration: number,
    namespace: string = "default",
    lineNumber: number | string | null = 1,
    dmlCount: number = 0,
    soqlCount: number = 0,
    dmlRows: number = 0,
    soqlRows: number = 0,
    soslCount: number = 0,
    soslRows: number = 0,
    totalThrownCount: number = 0,
  ): any {
    return {
      type: "METHOD_ENTRY",
      text: name,
      namespace,
      lineNumber,
      duration: { total: duration, self: selfDuration },
      dmlCount: { total: dmlCount, self: dmlCount },
      soqlCount: { total: soqlCount, self: soqlCount },
      dmlRowCount: { total: dmlRows, self: dmlRows },
      soqlRowCount: { total: soqlRows, self: soqlRows },
      soslCount: { total: soslCount, self: soslCount },
      soslRowCount: { total: soslRows, self: soslRows },
      totalThrownCount,
      children: [],
    };
  }

  function createMockApexLog(): any {
    const slowMethod = createMockLogLine(
      "SlowMethod",
      500000000,
      500000000,
      "default",
      1,
      5,
      10,
      100,
      1000,
    );
    const mediumMethod = createMockLogLine(
      "MediumMethod",
      400000000,
      400000000,
      "default",
      2,
      2,
      3,
      50,
      200,
    );
    const fastMethod = createMockLogLine(
      "FastMethod",
      100000000,
      100000000,
      "default",
      3,
      1,
      1,
      10,
      50,
    );

    return {
      duration: { total: 1000000000, self: 0 },
      children: [slowMethod, mediumMethod, fastMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 8, self: 0 },
      soqlCount: { total: 14, self: 0 },
      dmlRowCount: { total: 160, self: 0 },
      soqlRowCount: { total: 1250, self: 0 },
    };
  }

  function createMockApexLogWithNamespaces(): any {
    const defaultMethod = createMockLogLine(
      "DefaultMethod",
      500000000,
      500000000,
      "default",
      1,
    );
    const customMethod = createMockLogLine(
      "CustomMethod",
      400000000,
      400000000,
      "CustomNamespace",
      2,
    );

    return {
      duration: { total: 1000000000, self: 100000000 },
      children: [defaultMethod, customMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 0, self: 0 },
      soqlCount: { total: 0, self: 0 },
      dmlRowCount: { total: 0, self: 0 },
      soqlRowCount: { total: 0, self: 0 },
    };
  }

  function createMockApexLogWithNullValues(): any {
    const nullMethod: any = {
      type: "METHOD_ENTRY",
      text: null,
      namespace: null,
      lineNumber: null,
      duration: { total: 500000000, self: 500000000 },
      dmlCount: { total: 0, self: 0 },
      soqlCount: { total: 0, self: 0 },
      dmlRowCount: { total: 0, self: 0 },
      soqlRowCount: { total: 0, self: 0 },
      soslCount: { total: 0, self: 0 },
      soslRowCount: { total: 0, self: 0 },
      totalThrownCount: 0,
      children: [],
    };

    return {
      duration: { total: 1000000000, self: 500000000 },
      children: [nullMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 0, self: 0 },
      soqlCount: { total: 0, self: 0 },
      dmlRowCount: { total: 0, self: 0 },
      soqlRowCount: { total: 0, self: 0 },
    };
  }

  function createMockApexLogWithZeroTotalTime(): any {
    const method = createMockLogLine("TestMethod", 500000000, 500000000);

    return {
      duration: { total: 0, self: 0 },
      children: [method],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 0, self: 0 },
      soqlCount: { total: 0, self: 0 },
      dmlRowCount: { total: 0, self: 0 },
      soqlRowCount: { total: 0, self: 0 },
    };
  }

  function createEmptyMockApexLog(): any {
    return {
      duration: { total: 0, self: 0 },
      children: [],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 0, self: 0 },
      soqlCount: { total: 0, self: 0 },
      dmlRowCount: { total: 0, self: 0 },
      soqlRowCount: { total: 0, self: 0 },
    };
  }

  function createMockApexLogWithHighSOQL(): any {
    const highSOQLMethod = createMockLogLine(
      "HighSOQLMethod",
      500000000,
      50000000, // Low self duration to get selfPercentage < 10%
      "default",
      1,
      2,
      8,
      50,
      500,
    );

    return {
      duration: { total: 1000000000, self: 500000000 },
      children: [highSOQLMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 2, self: 0 },
      soqlCount: { total: 8, self: 0 },
      dmlRowCount: { total: 50, self: 0 },
      soqlRowCount: { total: 500, self: 0 },
    };
  }

  function createMockApexLogWithHighDML(): any {
    const highDMLMethod = createMockLogLine(
      "HighDMLMethod",
      500000000,
      50000000, // Low self duration to get selfPercentage < 10%
      "default",
      1,
      6,
      2,
      100,
      50,
    );

    return {
      duration: { total: 1000000000, self: 500000000 },
      children: [highDMLMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 6, self: 0 },
      soqlCount: { total: 2, self: 0 },
      dmlRowCount: { total: 100, self: 0 },
      soqlRowCount: { total: 50, self: 0 },
    };
  }

  function createMockApexLogWithHighSOSL(): any {
    const highSOSLMethod = createMockLogLine(
      "HighSOSLMethod",
      500000000,
      50000000, // Low self duration to get selfPercentage < 10%
      "default",
      1,
      1, // dmlCount
      2, // soqlCount
      10, // dmlRows
      50, // soqlRows
      5, // soslCount (> 3 triggers recommendation)
      200, // soslRows
    );

    return {
      duration: { total: 1000000000, self: 500000000 },
      children: [highSOSLMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 1, self: 0 },
      soqlCount: { total: 2, self: 0 },
      dmlRowCount: { total: 10, self: 0 },
      soqlRowCount: { total: 50, self: 0 },
    };
  }

  function createMockApexLogWithHighSOQLRows(): any {
    const highRowsMethod = createMockLogLine(
      "HighRowsMethod",
      500000000,
      50000000, // Low self duration to get selfPercentage < 10%
      "default",
      1,
      1,
      2,
      10,
      1500,
    );

    return {
      duration: { total: 1000000000, self: 500000000 },
      children: [highRowsMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 1, self: 0 },
      soqlCount: { total: 2, self: 0 },
      dmlRowCount: { total: 10, self: 0 },
      soqlRowCount: { total: 1500, self: 0 },
    };
  }

  function createMockApexLogWithHighPercentage(): any {
    const highPercentageMethod = createMockLogLine(
      "HighPercentageMethod",
      300000000,
      300000000,
      "default",
      1,
      1,
      1,
      10,
      50,
    );

    return {
      duration: { total: 1000000000, self: 700000000 },
      children: [highPercentageMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 1, self: 0 },
      soqlCount: { total: 1, self: 0 },
      dmlRowCount: { total: 10, self: 0 },
      soqlRowCount: { total: 50, self: 0 },
    };
  }

  function createMockApexLogWithGoodPerformance(): any {
    const goodMethod = createMockLogLine(
      "GoodMethod",
      100000000,
      100000000,
      "default",
      1,
      1,
      2,
      50,
      100,
    );

    return {
      duration: { total: 1000000000, self: 900000000 },
      children: [goodMethod],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 1, self: 0 },
      soqlCount: { total: 2, self: 0 },
      dmlRowCount: { total: 50, self: 0 },
      soqlRowCount: { total: 100, self: 0 },
    };
  }

  function createMockApexLogWithManyMethods(): any {
    const method1 = createMockLogLine(
      "Method1",
      400000000,
      400000000,
      "default",
      1,
      8,
      8,
      100,
      1200,
    );
    const method2 = createMockLogLine(
      "Method2",
      300000000,
      300000000,
      "default",
      2,
      6,
      6,
      80,
      1000,
    );
    const method3 = createMockLogLine(
      "Method3",
      200000000,
      200000000,
      "default",
      3,
      4,
      4,
      60,
      800,
    );
    const method4 = createMockLogLine(
      "Method4",
      100000000,
      100000000,
      "default",
      4,
      8,
      8,
      100,
      1200,
    );

    return {
      duration: { total: 1000000000, self: 0 },
      children: [method1, method2, method3, method4],
      type: "EXECUTION_STARTED",
      text: "Root",
      namespace: "default",
      lineNumber: null,
      dmlCount: { total: 26, self: 0 },
      soqlCount: { total: 26, self: 0 },
      dmlRowCount: { total: 340, self: 0 },
      soqlRowCount: { total: 4200, self: 0 },
    };
  }
});
