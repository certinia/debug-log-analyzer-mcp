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

import { ApexLogServer, parseServerConfig } from "../src/server";

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
  executeAnonymousToolConfig: jest.fn((disabled = false) => ({
    title: "Execute Anonymous Apex",
    description: disabled
      ? "[DISABLED on this server] Execute a snippet of anonymous Apex and retrieve the resulting log"
      : "Execute a snippet of anonymous Apex and retrieve the resulting log",
    inputSchema: {},
    annotations: {},
  })),
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
    process.removeAllListeners("SIGTERM");
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

    it.each(["SIGINT", "SIGTERM"])("closes cleanly on %s", async (signal) => {
      const mockProcessOnce = jest.spyOn(process, "once");

      new ApexLogServer();

      expect(mockProcessOnce).toHaveBeenCalledWith(signal, expect.any(Function));
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

    it("should always leave execute_anonymous discoverable", async () => {
      new ApexLogServer();

      const execAnonTool = registeredTools.get("execute_anonymous")!;
      expect(execAnonTool.enabled).toBe(true);
      expect(execAnonTool.disable).not.toHaveBeenCalled();
    });

    it("should keep execute_anonymous discoverable when apex execution is disabled", async () => {
      new ApexLogServer({ apexExecutionDisabled: true });

      const execAnonTool = registeredTools.get("execute_anonymous")!;
      expect(execAnonTool.enabled).toBe(true);
      expect(execAnonTool.disable).not.toHaveBeenCalled();
      expect(execAnonTool.config.description).toContain(
        "[DISABLED on this server]",
      );
    });

    it("should not mark the tool disabled in its description by default", async () => {
      new ApexLogServer();

      const execAnonTool = registeredTools.get("execute_anonymous")!;
      expect(execAnonTool.config.description).not.toContain("[DISABLED");
    });
  });

  describe("Tool Request Handling", () => {
    it("should handle analyze_apex_log_performance tool correctly", async () => {
      new ApexLogServer();

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
      new ApexLogServer();

      const tool = registeredTools.get("get_apex_log_summary")!;
      const args = { logFilePath: "/path/to/test.log" };

      const result = await tool.callback(args, {} as any);

      expect(getLogSummary).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockSummaryResult);
    });

    it("should handle find_performance_bottlenecks tool correctly", async () => {
      new ApexLogServer();

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

    it("should pass the default policy to execute_anonymous", async () => {
      new ApexLogServer();

      const tool = registeredTools.get("execute_anonymous")!;
      const args = { apex: "System.debug('test');" };

      const result = await tool.callback(args, {} as any);

      expect(executeAnonymous).toHaveBeenCalledWith(expect.anything(), args, {
        allowProductionOrgs: false,
        apexExecutionDisabled: false,
        classificationCache: expect.any(Map),
      });
      expect(result).toEqual(mockExecuteAnonymousResult);
    });

    it("should pass --allow-production-orgs through to execute_anonymous", async () => {
      new ApexLogServer({ allowProductionOrgs: true });

      const tool = registeredTools.get("execute_anonymous")!;
      await tool.callback({ apex: "System.debug('test');" }, {} as any);

      expect(executeAnonymous).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ allowProductionOrgs: true }),
      );
    });

    it("should pass --no-apex-execution through to execute_anonymous", async () => {
      new ApexLogServer({ apexExecutionDisabled: true });

      const tool = registeredTools.get("execute_anonymous")!;
      await tool.callback({ apex: "System.debug('test');" }, {} as any);

      expect(executeAnonymous).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ apexExecutionDisabled: true }),
      );
    });

    it("should reuse one classification cache across calls", async () => {
      new ApexLogServer();

      const tool = registeredTools.get("execute_anonymous")!;
      await tool.callback({ apex: "System.debug(1);" }, {} as any);
      await tool.callback({ apex: "System.debug(2);" }, {} as any);

      const calls = (executeAnonymous as jest.Mock).mock.calls;
      expect(calls[0][2].classificationCache).toBe(
        calls[1][2].classificationCache,
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
      new ApexLogServer();

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

describe("parseServerConfig", () => {
  // The suite above restores the shared console spy in afterAll, so use a local one.
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("should default to the safe policy with no flags", () => {
    expect(parseServerConfig([])).toEqual({
      allowProductionOrgs: false,
      apexExecutionDisabled: false,
    });
  });

  it("should read --allow-production-orgs", () => {
    expect(parseServerConfig(["--allow-production-orgs"])).toEqual({
      allowProductionOrgs: true,
      apexExecutionDisabled: false,
    });
  });

  it("should read --no-apex-execution", () => {
    expect(parseServerConfig(["--no-apex-execution"])).toEqual({
      allowProductionOrgs: false,
      apexExecutionDisabled: true,
    });
  });

  it("should still start when the deprecated --allowed-orgs is passed", () => {
    expect(
      parseServerConfig(["--allowed-orgs", "ALLOW_ALL_ORGS"]),
    ).toEqual({
      allowProductionOrgs: false,
      apexExecutionDisabled: false,
    });
  });

  it("should warn that --allowed-orgs is deprecated and ignored", () => {
    parseServerConfig(["--allowed-orgs", "dev@example.com"]);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("--allowed-orgs is deprecated and ignored"),
    );
  });

  it("should not warn when --allowed-orgs is absent", () => {
    parseServerConfig(["--allow-production-orgs"]);

    expect(consoleError).not.toHaveBeenCalled();
  });
});
