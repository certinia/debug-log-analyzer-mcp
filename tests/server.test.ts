/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Mock the MCP SDK components
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    registerTool: jest.fn(() => ({
      enable: jest.fn(),
      disable: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      enabled: true,
    })),
    connect: jest.fn(),
    close: jest.fn(),
    sendToolListChanged: jest.fn(),
    server: { onerror: undefined },
  })),
}));
jest.mock("@modelcontextprotocol/sdk/server/stdio.js");

import { ApexLogServer } from "../src/server";

// Mock the tool modules
jest.mock("../src/tools/analyzeLogPerformance", () => ({
  analyzeLogPerformance: jest.fn(),
  analyzeLogPerformanceToolConfig: {
    title: "Analyze Apex Log Performance",
    description:
      "Analyze an Apex debug log file and identify the slowest running methods",
    inputSchema: {},
    annotations: {},
  },
}));

jest.mock("../src/tools/getLogSummary", () => ({
  getLogSummary: jest.fn(),
  getLogSummaryToolConfig: {
    title: "Get Apex Log Summary",
    description: "Get a high-level summary of an Apex debug log",
    inputSchema: {},
    annotations: {},
  },
}));

jest.mock("../src/tools/findPerformanceBottlenecks", () => ({
  findPerformanceBottlenecks: jest.fn(),
  findPerformanceBottlenecksToolConfig: {
    title: "Find Performance Bottlenecks",
    description: "Identify performance bottlenecks in an Apex log",
    inputSchema: {},
    annotations: {},
  },
}));

jest.mock("../src/tools/executeAnonymous", () => ({
  executeAnonymous: jest.fn(),
  executeAnonymousToolConfig: {
    title: "Execute Anonymous Apex",
    description:
      "Execute a snippet of anonymous Apex and retrieve the resulting log",
    inputSchema: {},
    annotations: {},
  },
}));

// Import the tools after mocking
import { analyzeLogPerformance } from "../src/tools/analyzeLogPerformance";
import { getLogSummary } from "../src/tools/getLogSummary";
import { findPerformanceBottlenecks } from "../src/tools/findPerformanceBottlenecks";
import { executeAnonymous } from "../src/tools/executeAnonymous";

// Mock process methods
const mockExit = jest.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("Process exit called");
}) as any);

// Mock console methods
const mockConsoleError = jest
  .spyOn(console, "error")
  .mockImplementation(() => {});

describe("ApexLogServer", () => {
  let mockRegisterTool: jest.Mock;
  let mockConnect: jest.Mock;
  let mockClose: jest.Mock;
  let mockTransport: jest.Mocked<StdioServerTransport>;
  let registeredTools: Map<
    string,
    { config: any; callback: (...args: any[]) => any; enabled: boolean }
  >;

  // Mock data for testing
  const mockAnalysisResult = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          totalMethods: 5,
          totalExecutionTime: 1000000,
          slowestMethods: [],
          summary: "Test summary",
          recommendations: [],
        }),
      },
    ],
  };

  const mockSummaryResult = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          file: "test.log",
          totalExecutionTime: 1000000,
          totalMethods: 5,
          governorLimits: {},
        }),
      },
    ],
  };

  const mockBottleneckResult = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          cpuBottlenecks: {},
          databaseBottlenecks: {},
          governorLimitWarnings: {},
        }),
      },
    ],
  };

  const mockExecuteAnonymousResult = {
    content: [
      {
        type: "text" as const,
        text: "APEX DEBUG LOG CONTENT",
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    registeredTools = new Map();

    mockRegisterTool = jest.fn((name, config, callback) => {
      const tool = {
        config,
        callback,
        enabled: true,
        enable: jest.fn(() => {
          tool.enabled = true;
        }),
        disable: jest.fn(() => {
          tool.enabled = false;
        }),
        remove: jest.fn(),
        update: jest.fn(),
      };
      registeredTools.set(name, tool);
      return tool;
    });
    mockConnect = jest.fn();
    mockClose = jest.fn();

    const mockServer = {
      registerTool: mockRegisterTool,
      connect: mockConnect,
      close: mockClose,
      sendToolListChanged: jest.fn(),
      server: {
        onerror: undefined as ((error: unknown) => void) | undefined,
        listRoots: jest.fn(),
      },
    };

    // Setup transport mock
    mockTransport = {} as jest.Mocked<StdioServerTransport>;

    (McpServer as jest.MockedClass<typeof McpServer>).mockImplementation(
      () => mockServer as any,
    );
    (
      StdioServerTransport as jest.MockedClass<typeof StdioServerTransport>
    ).mockImplementation(() => mockTransport);

    // Setup tool mocks
    (
      analyzeLogPerformance as jest.MockedFunction<typeof analyzeLogPerformance>
    ).mockResolvedValue(mockAnalysisResult);
    (
      getLogSummary as jest.MockedFunction<typeof getLogSummary>
    ).mockResolvedValue(mockSummaryResult);
    (
      findPerformanceBottlenecks as jest.MockedFunction<
        typeof findPerformanceBottlenecks
      >
    ).mockResolvedValue(mockBottleneckResult);
    (
      executeAnonymous as jest.MockedFunction<typeof executeAnonymous>
    ).mockResolvedValue(mockExecuteAnonymousResult);
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.removeAllListeners("SIGINT");
  });

  afterAll(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  describe("Server Initialization", () => {
    it("should create server with correct configuration", async () => {
      new ApexLogServer();

      expect(McpServer).toHaveBeenCalledWith(
        {
          name: "apex-log-mcp",
          version: "1.0.0",
          description: expect.any(String),
        },
        {
          capabilities: {
            tools: {},
          },
          instructions: expect.any(String),
        },
      );
    });

    it("should setup error handling", async () => {
      new ApexLogServer();

      const mcpInstance = (McpServer as jest.MockedClass<typeof McpServer>).mock
        .results[0].value;
      expect(mcpInstance.server.onerror).toBeDefined();

      // Test error handler
      const testError = new Error("Test error");
      mcpInstance.server.onerror(testError);

      expect(mockConsoleError).toHaveBeenCalledWith("[MCP Error]", testError);
    });

    it("should setup SIGINT handler", async () => {
      const mockProcessOnce = jest.spyOn(process, "once");

      new ApexLogServer();

      expect(mockProcessOnce).toHaveBeenCalledWith(
        "SIGINT",
        expect.any(Function),
      );
    });
  });

  describe("Tool Registration", () => {
    it("should register all 4 tools via registerTool", async () => {
      new ApexLogServer();

      expect(mockRegisterTool).toHaveBeenCalledTimes(4);
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "analyze_apex_log_performance",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "get_apex_log_summary",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "find_performance_bottlenecks",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "execute_anonymous",
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("should enable execute_anonymous when allowedOrgs is provided", async () => {
      new ApexLogServer(["ALLOW_ALL_ORGS"]);

      const execAnonTool = registeredTools.get("execute_anonymous")!;
      expect(execAnonTool.enabled).toBe(true);
    });

    it("should disable execute_anonymous when allowedOrgs is empty", async () => {
      new ApexLogServer();

      const execAnonTool = registeredTools.get("execute_anonymous")!;
      expect(execAnonTool.enabled).toBe(false);
    });
  });

  describe("Tool Request Handling", () => {
    it("should handle analyze_apex_log_performance tool correctly", async () => {
      new ApexLogServer(["ALLOW_ALL_ORGS"]);

      const tool = registeredTools.get("analyze_apex_log_performance")!;
      const args = {
        logFilePath: "/path/to/test.log",
        topMethods: 5,
      };

      const result = await tool.callback(args, {} as any);

      expect(analyzeLogPerformance).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockAnalysisResult);
    });

    it("should handle get_apex_log_summary tool correctly", async () => {
      new ApexLogServer(["ALLOW_ALL_ORGS"]);

      const tool = registeredTools.get("get_apex_log_summary")!;
      const args = { logFilePath: "/path/to/test.log" };

      const result = await tool.callback(args, {} as any);

      expect(getLogSummary).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockSummaryResult);
    });

    it("should handle find_performance_bottlenecks tool correctly", async () => {
      new ApexLogServer(["ALLOW_ALL_ORGS"]);

      const tool = registeredTools.get("find_performance_bottlenecks")!;
      const args = {
        logFilePath: "/path/to/test.log",
        analysisType: "cpu",
      };

      const result = await tool.callback(args, {} as any);

      expect(findPerformanceBottlenecks).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockBottleneckResult);
    });

    it("should handle tool execution errors gracefully", async () => {
      const error = new Error("Tool execution failed");
      (
        analyzeLogPerformance as jest.MockedFunction<
          typeof analyzeLogPerformance
        >
      ).mockRejectedValueOnce(error);

      new ApexLogServer();

      const tool = registeredTools.get("analyze_apex_log_performance")!;

      await expect(
        tool.callback({ logFilePath: "/path/to/test.log" }, {} as any),
      ).rejects.toThrow("Tool execution failed");
    });

    it("should return error when execute_anonymous called with empty allowedOrgs", async () => {
      new ApexLogServer();

      const tool = registeredTools.get("execute_anonymous")!;

      await expect(
        tool.callback({ apex: "System.debug('test');" }, {} as any),
      ).rejects.toThrow(
        "execute_anonymous is disabled. Configure --allowed-orgs to enable it.",
      );
    });
  });

  describe("Server Lifecycle", () => {
    it("should start server correctly", async () => {
      const apexLogServer = new ApexLogServer();
      await apexLogServer.run();

      expect(StdioServerTransport).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalledWith(mockTransport);
      expect(mockConsoleError).toHaveBeenCalledWith(
        "Apex Log MCP Server running on stdio",
      );
    });

    it("should connect to stdio transport", async () => {
      const apexLogServer = new ApexLogServer();
      await apexLogServer.run();

      expect(StdioServerTransport).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalledWith(mockTransport);
    });

    it("should handle SIGINT and close server", async () => {
      new ApexLogServer();

      // Find the SIGINT handler
      const processOnceCalls = jest.spyOn(process, "once").mock.calls;
      const sigintCall = processOnceCalls.find(
        (call: any) => call[0] === "SIGINT",
      );
      expect(sigintCall).toBeDefined();

      const sigintHandler = sigintCall![1] as () => Promise<void>;

      // Test SIGINT handler
      try {
        await sigintHandler();
      } catch (error) {
        // Expected to throw due to mocked process.exit
        expect((error as Error).message).toBe("Process exit called");
      }

      expect(mockClose).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow for analyze_apex_log_performance", async () => {
      new ApexLogServer(["ALLOW_ALL_ORGS"]);

      // Verify all tools registered
      expect(registeredTools.size).toBe(4);

      // Test tool execution
      const tool = registeredTools.get("analyze_apex_log_performance")!;
      const args = {
        logFilePath: "/path/to/test.log",
        topMethods: 10,
        minDuration: 1000,
      };

      const result = await tool.callback(args, {} as any);
      expect(result).toEqual(mockAnalysisResult);
      expect(analyzeLogPerformance).toHaveBeenCalledWith(args);
    });

    it("should handle edge cases with malformed requests", async () => {
      new ApexLogServer();

      (
        analyzeLogPerformance as jest.MockedFunction<
          typeof analyzeLogPerformance
        >
      ).mockRejectedValueOnce(new Error("Invalid arguments"));

      const tool = registeredTools.get("analyze_apex_log_performance")!;

      await expect(tool.callback(null as any, {} as any)).rejects.toThrow(
        "Invalid arguments",
      );
    });
  });

  describe("Type Safety", () => {
    it("should handle typed arguments correctly", async () => {
      new ApexLogServer();

      const tool = registeredTools.get("find_performance_bottlenecks")!;
      const args = {
        logFilePath: "/path/to/test.log",
        analysisType: "database" as const,
      };

      await tool.callback(args, {} as any);

      expect(findPerformanceBottlenecks).toHaveBeenCalledWith(args);
    });
  });
});
