/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { jest } from "@jest/globals";
import {
  findPerformanceBottlenecks,
  BottleneckArgs,
  BottleneckResult,
} from "../src/tools/findPerformanceBottlenecks";
import { parse, ApexLog, Limits, GovernorLimits } from "../src/ApexLogParser";
import { extractMethods, SlowMethod } from "../src/tools/analyzeLogPerformance";
import { decode } from "@toon-format/toon";

// Mock dependencies
jest.mock("fs", () => ({
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

jest.mock("../src/ApexLogParser", () => ({
  parse: jest.fn(),
}));

jest.mock("../src/tools/analyzeLogPerformance", () => ({
  extractMethods: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockParse = parse as jest.MockedFunction<typeof parse>;
const mockExtractMethods = extractMethods as jest.MockedFunction<
  typeof extractMethods
>;

// Helper function to create mock governor limits
function createMockGovernorLimits(
  overrides: Partial<Limits> = {}
): GovernorLimits {
  const defaultLimits: Limits = {
    soqlQueries: { used: 0, limit: 100 },
    soslQueries: { used: 0, limit: 20 },
    queryRows: { used: 0, limit: 50000 },
    dmlStatements: { used: 0, limit: 150 },
    publishImmediateDml: { used: 0, limit: 10 },
    dmlRows: { used: 0, limit: 10000 },
    cpuTime: { used: 0, limit: 10000 },
    heapSize: { used: 0, limit: 6000000 },
    callouts: { used: 0, limit: 100 },
    emailInvocations: { used: 0, limit: 10 },
    futureCalls: { used: 0, limit: 50 },
    queueableJobsAddedToQueue: { used: 0, limit: 50 },
    mobileApexPushCalls: { used: 0, limit: 10 },
  };

  return {
    ...defaultLimits,
    ...overrides,
    byNamespace: new Map<string, Limits>(),
  };
}

// Helper function to create mock ApexLog
function createMockApexLog(governorLimits?: Partial<Limits>): ApexLog {
  const mockLog = {
    type: null,
    text: "LOG_ROOT",
    timestamp: 0,
    exitStamp: 1000000000,
    size: 1024,
    debugLevels: [],
    namespaces: ["default", "MyNamespace"],
    logIssues: [],
    parsingErrors: [],
    governorLimits: createMockGovernorLimits(governorLimits),
    duration: {
      total: 1000000000, // 1 second in nanoseconds
      self: 1000000000,
    },
    children: [],
    parent: null,
    lineNumber: null,
    namespace: "default",
    dmlCount: { total: 0, self: 0 },
    soqlCount: { total: 0, self: 0 },
    dmlRowCount: { total: 0, self: 0 },
    soqlRowCount: { total: 0, self: 0 },
  } as unknown as ApexLog;

  return mockLog;
}

// Helper function to create mock slow methods
function createMockSlowMethods(): SlowMethod[] {
  return [
    {
      name: "MyClass.slowMethod1",
      duration: 500000000, // 500ms
      selfDuration: 300000000,
      namespace: "MyNamespace",
      lineNumber: 10,
      dmlCount: 5,
      soqlCount: 8,
      dmlRows: 100,
      soqlRows: 1500,
      selfPercentage: 50.0,
    },
    {
      name: "MyClass.slowMethod2",
      duration: 300000000, // 300ms
      selfDuration: 250000000,
      namespace: "default",
      lineNumber: 25,
      dmlCount: 2,
      soqlCount: 3,
      dmlRows: 50,
      soqlRows: 500,
      selfPercentage: 30.0,
    },
    {
      name: "AnotherClass.method",
      duration: 200000000, // 200ms
      selfDuration: 150000000,
      namespace: "MyNamespace",
      lineNumber: 42,
      dmlCount: 1,
      soqlCount: 2,
      dmlRows: 25,
      soqlRows: 200,
      selfPercentage: 20.0,
    },
  ];
}

describe("findPerformanceBottlenecks", () => {
  const mockLogFilePath = "/path/to/test.log";
  const mockLogContent = "mock log content";

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.access.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue(mockLogContent);
  });

  describe("File validation and error handling", () => {
    it("should throw an error if log file does not exist", async () => {
      const args: BottleneckArgs = { logFilePath: "/nonexistent/file.log" };
      mockFs.access.mockRejectedValue(new Error("File not found"));

      await expect(findPerformanceBottlenecks(args)).rejects.toThrow(
        "Log file not found: /nonexistent/file.log"
      );

      expect(mockFs.access).toHaveBeenCalledWith("/nonexistent/file.log");
      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should handle file system errors during file reading", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };
      mockFs.readFile.mockRejectedValue(new Error("Permission denied"));

      await expect(findPerformanceBottlenecks(args)).rejects.toThrow(
        "Permission denied"
      );

      expect(mockFs.access).toHaveBeenCalledWith(mockLogFilePath);
      expect(mockFs.readFile).toHaveBeenCalledWith(mockLogFilePath, "utf-8");
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("should handle parsing errors", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };
      mockParse.mockImplementation(() => {
        throw new Error("Invalid log format");
      });

      await expect(findPerformanceBottlenecks(args)).rejects.toThrow(
        "Invalid log format"
      );

      expect(mockFs.access).toHaveBeenCalledWith(mockLogFilePath);
      expect(mockFs.readFile).toHaveBeenCalledWith(mockLogFilePath, "utf-8");
      expect(mockParse).toHaveBeenCalledWith(mockLogContent);
    });
  });

  describe('Analysis type "all" (default)', () => {
    it('should perform all types of analysis when analysisType is "all"', async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "all",
      };

      const mockLog = createMockApexLog({
        cpuTime: { used: 8500, limit: 10000 }, // 85% usage
        soqlQueries: { used: 90, limit: 100 }, // 90% usage
        dmlStatements: { used: 120, limit: 150 }, // 80% usage
      });

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue(createMockSlowMethods());

      const result = await findPerformanceBottlenecks(args);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsedResult = toonDecode(result);

      // Should contain all analysis types
      expect(parsedResult).toHaveProperty("cpuBottlenecks");
      expect(parsedResult).toHaveProperty("databaseBottlenecks");
      expect(parsedResult).toHaveProperty("methodBottlenecks");
      expect(parsedResult).toHaveProperty("governorLimitWarnings");

      // Verify CPU analysis
      expect(parsedResult.cpuBottlenecks).toMatchObject({
        cpuTimeUsed: 8500,
        cpuTimeLimit: 10000,
        cpuUsagePercentage: 85,
        warning: "High CPU usage detected - consider optimizing algorithms",
      });

      // Verify database analysis
      expect(parsedResult.databaseBottlenecks!.soqlQueries).toMatchObject({
        used: 90,
        limit: 100,
        percentage: 90,
      });
      expect(parsedResult.databaseBottlenecks!.dmlStatements).toMatchObject({
        used: 120,
        limit: 150,
        percentage: 80,
      });

      // Verify method analysis
      expect(parsedResult.methodBottlenecks).toMatchObject({
        totalMethods: 3,
        methodsByNamespace: expect.arrayContaining([
          expect.objectContaining({
            namespace: "MyNamespace",
            methodCount: 2,
            totalDuration: 700000000, // 500ms + 200ms
          }),
          expect.objectContaining({
            namespace: "default",
            methodCount: 1,
            totalDuration: 300000000,
          }),
        ]),
      });

      // Verify governor limit warnings
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "cpuTime: 85.0% of limit used (8500/10000)"
      );
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "soqlQueries: 90.0% of limit used (90/100)"
      );
    });

    it('should use "all" as default when analysisType is not specified', async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };
      const mockLog = createMockApexLog();

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult).toHaveProperty("cpuBottlenecks");
      expect(parsedResult).toHaveProperty("databaseBottlenecks");
      expect(parsedResult).toHaveProperty("methodBottlenecks");
      expect(parsedResult).toHaveProperty("governorLimitWarnings");
    });
  });

  describe('Analysis type "cpu"', () => {
    it('should only perform CPU analysis when analysisType is "cpu"', async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "cpu",
      };

      const mockLog = createMockApexLog({
        cpuTime: { used: 9000, limit: 10000 }, // 90% usage
      });

      mockParse.mockReturnValue(mockLog);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      // Should only contain CPU analysis and governor limit warnings
      expect(parsedResult).toHaveProperty("cpuBottlenecks");
      expect(parsedResult).not.toHaveProperty("databaseBottlenecks");
      expect(parsedResult).not.toHaveProperty("methodBottlenecks");
      expect(parsedResult).toHaveProperty("governorLimitWarnings");

      expect(parsedResult.cpuBottlenecks).toMatchObject({
        cpuTimeUsed: 9000,
        cpuTimeLimit: 10000,
        cpuUsagePercentage: 90,
        warning: "High CPU usage detected - consider optimizing algorithms",
      });
    });

    it("should not show CPU information when usage is below 80%", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "cpu",
      };

      const mockLog = createMockApexLog({
        cpuTime: { used: 5000, limit: 10000 }, // 50% usage
      });

      mockParse.mockReturnValue(mockLog);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.cpuBottlenecks).toMatchObject({});
    });

    it("should handle zero CPU limit", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "cpu",
      };

      const mockLog = createMockApexLog({
        cpuTime: { used: 1000, limit: 0 },
      });

      mockParse.mockReturnValue(mockLog);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.cpuBottlenecks).toMatchObject({
        cpuTimeUsed: 1000,
        cpuTimeLimit: 0,
        cpuUsagePercentage: 0,
        warning: null,
      });
    });
  });

  describe('Analysis type "database"', () => {
    it('should only perform database analysis when analysisType is "database"', async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "database",
      };

      const mockLog = createMockApexLog({
        soqlQueries: { used: 75, limit: 100 },
        dmlStatements: { used: 100, limit: 150 },
        queryRows: { used: 30000, limit: 50000 },
      });

      mockParse.mockReturnValue(mockLog);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      // Should only contain database analysis and governor limit warnings
      expect(parsedResult).not.toHaveProperty("cpuBottlenecks");
      expect(parsedResult).toHaveProperty("databaseBottlenecks");
      expect(parsedResult).not.toHaveProperty("methodBottlenecks");
      expect(parsedResult).toHaveProperty("governorLimitWarnings");

      expect(parsedResult.databaseBottlenecks).toMatchObject({
        soqlQueries: {
          used: 75,
          limit: 100,
          percentage: 75,
        },
        dmlStatements: {
          used: 100,
          limit: 150,
          percentage: expect.closeTo(66.67, 1),
        },
        queryRows: {
          used: 30000,
          limit: 50000,
          percentage: 60,
        },
      });
    });

    it("should handle zero database limits", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "database",
      };

      const mockLog = createMockApexLog({
        soqlQueries: { used: 10, limit: 0 },
        dmlStatements: { used: 5, limit: 0 },
        queryRows: { used: 1000, limit: 0 },
      });

      mockParse.mockReturnValue(mockLog);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.databaseBottlenecks).toMatchObject({
        soqlQueries: {
          used: 10,
          limit: 0,
          percentage: 0,
        },
        dmlStatements: {
          used: 5,
          limit: 0,
          percentage: 0,
        },
        queryRows: {
          used: 1000,
          limit: 0,
          percentage: 0,
        },
      });
    });
  });

  describe('Analysis type "methods"', () => {
    it('should only perform method analysis when analysisType is "methods"', async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "methods",
      };

      const mockLog = createMockApexLog();
      const mockMethods = createMockSlowMethods();

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue(mockMethods);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      // Should only contain method analysis and governor limit warnings
      expect(parsedResult).not.toHaveProperty("cpuBottlenecks");
      expect(parsedResult).not.toHaveProperty("databaseBottlenecks");
      expect(parsedResult).toHaveProperty("methodBottlenecks");
      expect(parsedResult).toHaveProperty("governorLimitWarnings");

      expect(parsedResult.methodBottlenecks).toMatchObject({
        totalMethods: 3,
        methodsByNamespace: expect.arrayContaining([
          expect.objectContaining({
            namespace: "MyNamespace",
            methodCount: 2,
            totalDuration: 700000000,
          }),
          expect.objectContaining({
            namespace: "default",
            methodCount: 1,
            totalDuration: 300000000,
          }),
        ]),
      });

      expect(mockExtractMethods).toHaveBeenCalledWith(mockLog, 0);
    });

    it("should handle empty methods list", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "methods",
      };

      const mockLog = createMockApexLog();

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.methodBottlenecks).toMatchObject({
        totalMethods: 0,
        methodsByNamespace: [],
      });
    });

    it("should group methods by namespace correctly", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "methods",
      };

      const mockLog = createMockApexLog();
      const methodsWithSingleNamespace: SlowMethod[] = [
        {
          name: "Method1",
          duration: 100000000,
          selfDuration: 80000000,
          namespace: "TestNamespace",
          lineNumber: 1,
          dmlCount: 1,
          soqlCount: 1,
          dmlRows: 10,
          soqlRows: 100,
          selfPercentage: 10,
        },
        {
          name: "Method2",
          duration: 200000000,
          selfDuration: 150000000,
          namespace: "TestNamespace",
          lineNumber: 2,
          dmlCount: 2,
          soqlCount: 2,
          dmlRows: 20,
          soqlRows: 200,
          selfPercentage: 20,
        },
      ];

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue(methodsWithSingleNamespace);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);
      const methodBottlenecks = parsedResult.methodBottlenecks as any;

      expect(methodBottlenecks.methodsByNamespace).toHaveLength(1);
      expect(methodBottlenecks.methodsByNamespace[0]).toMatchObject({
        namespace: "TestNamespace",
        methodCount: 2,
        totalDuration: 300000000,
      });
    });
  });

  describe("Governor limit warnings", () => {
    it("should generate warnings for high governor limit usage (>80%)", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      const mockLog = createMockApexLog({
        cpuTime: { used: 8500, limit: 10000 }, // 85%
        soqlQueries: { used: 90, limit: 100 }, // 90%
        dmlStatements: { used: 135, limit: 150 }, // 90%
        queryRows: { used: 45000, limit: 50000 }, // 90%
        heapSize: { used: 5100000, limit: 6000000 }, // 85%
      });

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "cpuTime: 85.0% of limit used (8500/10000)"
      );
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "soqlQueries: 90.0% of limit used (90/100)"
      );
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "dmlStatements: 90.0% of limit used (135/150)"
      );
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "queryRows: 90.0% of limit used (45000/50000)"
      );
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "heapSize: 85.0% of limit used (5100000/6000000)"
      );
    });

    it("should not generate warnings for low governor limit usage (<=80%)", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      const mockLog = createMockApexLog({
        cpuTime: { used: 7000, limit: 10000 }, // 70%
        soqlQueries: { used: 50, limit: 100 }, // 50%
        dmlStatements: { used: 100, limit: 150 }, // 66.67%
        queryRows: { used: 30000, limit: 50000 }, // 60%
      });

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.governorLimitWarnings.warnings).toHaveLength(0);
    });

    it("should not generate warnings for zero limits", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      const mockLog = createMockApexLog({
        cpuTime: { used: 1000, limit: 0 },
        soqlQueries: { used: 10, limit: 0 },
        dmlStatements: { used: 5, limit: 0 },
      });

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.governorLimitWarnings.warnings).toHaveLength(0);
    });

    it("should include governor limit details in the response", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      const customLimits = {
        cpuTime: { used: 5000, limit: 10000 },
        soqlQueries: { used: 25, limit: 100 },
        dmlStatements: { used: 50, limit: 150 },
      };
      const mockLog = createMockApexLog(customLimits);

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      expect(parsedResult.governorLimitWarnings.details).toMatchObject(
        expect.objectContaining(customLimits)
      );
    });

    it("should handle edge case of exactly 80% usage", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      const mockLog = createMockApexLog({
        cpuTime: { used: 8000, limit: 10000 }, // Exactly 80%
      });

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      // Should not generate warning for exactly 80% (warning threshold is > 80%)
      expect(parsedResult.governorLimitWarnings.warnings).toHaveLength(0);
    });

    it("should handle edge case of just over 80% usage", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      const mockLog = createMockApexLog({
        cpuTime: { used: 8001, limit: 10000 }, // 80.01%
      });

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      // Should generate warning for just over 80%
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "cpuTime: 80.0% of limit used (8001/10000)"
      );
    });
  });

  describe("Integration scenarios", () => {
    it("should handle complex scenario with multiple bottlenecks", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "all",
      };

      // Create a scenario with high usage across multiple areas
      const mockLog = createMockApexLog({
        cpuTime: { used: 9500, limit: 10000 }, // 95% - High CPU
        soqlQueries: { used: 95, limit: 100 }, // 95% - High SOQL
        dmlStatements: { used: 140, limit: 150 }, // 93.33% - High DML
        queryRows: { used: 48000, limit: 50000 }, // 96% - High query rows
        heapSize: { used: 5500000, limit: 6000000 }, // 91.67% - High heap
      });

      const mockMethods = [
        {
          name: "HighCPUMethod",
          duration: 800000000, // 800ms
          selfDuration: 600000000,
          namespace: "Performance",
          lineNumber: 100,
          dmlCount: 15, // High DML
          soqlCount: 20, // High SOQL
          dmlRows: 2000,
          soqlRows: 10000, // High rows
          selfPercentage: 80,
        },
        {
          name: "DatabaseHeavyMethod",
          duration: 150000000, // 150ms
          selfDuration: 120000000,
          namespace: "Database",
          lineNumber: 200,
          dmlCount: 25, // Very high DML
          soqlCount: 30, // Very high SOQL
          dmlRows: 5000,
          soqlRows: 25000, // Very high rows
          selfPercentage: 15,
        },
      ];

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue(mockMethods);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);
      const databaseBottlenecks = parsedResult.databaseBottlenecks as any;
      const methodBottlenecks = parsedResult.methodBottlenecks as any;
      const governorLimitWarnings = parsedResult.governorLimitWarnings as any;

      // Should identify all bottleneck types
      expect(parsedResult.cpuBottlenecks!.warning).toBe(
        "High CPU usage detected - consider optimizing algorithms"
      );
      expect(parsedResult.cpuBottlenecks!.cpuUsagePercentage).toBe(95);

      // Database bottlenecks should show high usage
      expect(databaseBottlenecks.soqlQueries.percentage).toBe(95);
      expect(databaseBottlenecks.dmlStatements.percentage).toBeCloseTo(
        93.33,
        1
      );
      expect(databaseBottlenecks.queryRows.percentage).toBe(96);

      // Method analysis should show multiple namespaces
      expect(methodBottlenecks.totalMethods).toBe(2);
      expect(methodBottlenecks.methodsByNamespace).toHaveLength(2);

      // Multiple governor limit warnings
      expect(governorLimitWarnings.warnings.length).toBeGreaterThan(3);
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "cpuTime: 95.0% of limit used (9500/10000)"
      );
      expect(parsedResult.governorLimitWarnings.warnings).toContain(
        "soqlQueries: 95.0% of limit used (95/100)"
      );
    });

    it("should handle optimal performance scenario", async () => {
      const args: BottleneckArgs = {
        logFilePath: mockLogFilePath,
        analysisType: "all",
      };

      // Create a scenario with low usage across all areas
      const mockLog = createMockApexLog({
        cpuTime: { used: 1000, limit: 10000 }, // 10%
        soqlQueries: { used: 5, limit: 100 }, // 5%
        dmlStatements: { used: 10, limit: 150 }, // 6.67%
        queryRows: { used: 1000, limit: 50000 }, // 2%
        heapSize: { used: 500000, limit: 6000000 }, // 8.33%
      });

      const mockMethods = [
        {
          name: "EfficientMethod",
          duration: 50000000, // 50ms
          selfDuration: 40000000,
          namespace: "Optimized",
          lineNumber: 50,
          dmlCount: 1,
          soqlCount: 1,
          dmlRows: 10,
          soqlRows: 100,
          selfPercentage: 5,
        },
      ];

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue(mockMethods);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);
      const databaseBottlenecks = parsedResult.databaseBottlenecks as any;
      const methodBottlenecks = parsedResult.methodBottlenecks as any;

      // No CPU warning
      expect(parsedResult.cpuBottlenecks!.warning).toBeUndefined();
      expect(parsedResult).toBeUndefined();

      // Low database usage
      expect(databaseBottlenecks.soqlQueries.percentage).toBeUndefined();
      expect(databaseBottlenecks.dmlStatements.percentage).toBeUndefined();
      expect(databaseBottlenecks.queryRows.percentage).toBeUndefined();

      // Simple method analysis
      expect(methodBottlenecks.totalMethods).toBe(1);

      // No governor limit warnings
      expect(parsedResult.governorLimitWarnings.warnings).toHaveLength(0);
    });
  });

  describe("Type validation and edge cases", () => {
    it("should validate that result has correct structure", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };
      const mockLog = createMockApexLog();

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);

      // Validate top-level structure
      expect(result).toHaveProperty("content");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect(result.content[0]).toHaveProperty("text");

      // Validate JSON structure
      const parsedResult = toonDecode(result);
      expect(parsedResult).toHaveProperty("governorLimitWarnings");
      expect(parsedResult.governorLimitWarnings).toHaveProperty("warnings");
      expect(parsedResult.governorLimitWarnings).toHaveProperty("details");
      expect(Array.isArray(parsedResult.governorLimitWarnings.warnings)).toBe(
        true
      );
    });

    it("should handle undefined values gracefully", async () => {
      const args: BottleneckArgs = { logFilePath: mockLogFilePath };

      // Create a mock log with some undefined/null values
      const mockLog = createMockApexLog();
      mockLog.governorLimits.cpuTime = { used: 5000, limit: 10000 };

      mockParse.mockReturnValue(mockLog);
      mockExtractMethods.mockReturnValue([]);

      const result = await findPerformanceBottlenecks(args);
      const parsedResult = toonDecode(result);

      // Should still work without errors
      expect(parsedResult).toHaveProperty("governorLimitWarnings");
      expect(Array.isArray(parsedResult.governorLimitWarnings.warnings)).toBe(
        false
      );
    });
  });

  // Helper function for decoding TOON-formatted data
  function toonDecode(result: any): BottleneckResult {
    return decode(result.content[0].text) as unknown as BottleneckResult;
  }
});
