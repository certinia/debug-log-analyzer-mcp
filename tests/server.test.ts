/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

// Mock the MCP SDK components
jest.mock("@modelcontextprotocol/server", () => ({
  // Only the server class is stubbed; the request-state codec stays real.
  ...jest.requireActual("@modelcontextprotocol/server"),
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
    server: {},
  })),
}));
jest.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: jest.fn(),
}));

import {
  createApexLogServer,
  parseServerConfig,
  runStdioServer,
} from "../src/server";

// Mock the tool modules
jest.mock("../src/tools/listSlowOperations", () => ({
  listSlowOperations: jest.fn(),
  listSlowOperationsToolConfig: {
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

jest.mock("../src/tools/listLimitRisks", () => ({
  listLimitRisks: jest.fn(),
  listLimitRisksToolConfig: {
    title: "Find Performance Bottlenecks",
    description: "Identify performance bottlenecks in an Apex log",
    inputSchema: {},
    annotations: {},
  },
}));

jest.mock("../src/tools/executeAnonymous", () => ({
  executeAnonymous: jest.fn(),
}));

// A module of its own in `src/`, so the server can register the tool without
// loading the handler and the Salesforce SDK behind it.
jest.mock("../src/tools/executeAnonymousDefinition", () => ({
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
import { listSlowOperations } from "../src/tools/listSlowOperations";
import { getLogSummary } from "../src/tools/getLogSummary";
import { listLimitRisks } from "../src/tools/listLimitRisks";
import { executeAnonymous } from "../src/tools/executeAnonymous";

// Mock process methods
const mockExit = jest.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("Process exit called");
}) as any);

// Mock console methods
const mockConsoleError = jest
  .spyOn(console, "error")
  .mockImplementation(() => {});

describe("createApexLogServer", () => {
  let mockRegisterTool: jest.Mock;
  let mockHandleClose: jest.Mock;
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
          durationTotalMs: 1000,
          returnedSelfPercentage: 0,
          operations: [],
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
          threshold: 80,
          atRisk: [],
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
    mockHandleClose = jest.fn().mockResolvedValue(undefined);

    const mockServer = {
      registerTool: mockRegisterTool,
      sendToolListChanged: jest.fn(),
      server: {
        listRoots: jest.fn(),
      },
    };

    (McpServer as jest.MockedClass<typeof McpServer>).mockImplementation(
      () => mockServer as any,
    );
    (serveStdio as jest.Mock).mockImplementation(() => ({
      close: mockHandleClose,
    }));

    // Setup tool mocks
    (
      listSlowOperations as jest.MockedFunction<typeof listSlowOperations>
    ).mockResolvedValue(mockAnalysisResult);
    (
      getLogSummary as jest.MockedFunction<typeof getLogSummary>
    ).mockResolvedValue(mockSummaryResult);
    (
      listLimitRisks as jest.MockedFunction<
        typeof listLimitRisks
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
      createApexLogServer();

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
          // Verifies a confirmation before any handler sees it.
          requestState: { verify: expect.any(Function) },
          cacheHints: {
            "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
          },
        },
      );
    });

    it("should not offer the definitions to a shared cache when a flag changed them", async () => {
      createApexLogServer({ apexExecutionDisabled: true });

      expect(McpServer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cacheHints: {
            "tools/list": { ttlMs: 3_600_000, cacheScope: "private" },
          },
        }),
      );
    });

    it("should setup error handling", async () => {
      runStdioServer();

      const options = (serveStdio as jest.Mock).mock.calls[0][1];
      const testError = new Error("Test error");
      options.onerror(testError);

      expect(mockConsoleError).toHaveBeenCalledWith("[MCP Error]", testError);
    });

    it.each(["SIGINT", "SIGTERM"])("closes cleanly on %s", async (signal) => {
      const mockProcessOnce = jest.spyOn(process, "once");

      runStdioServer();

      expect(mockProcessOnce).toHaveBeenCalledWith(signal, expect.any(Function));
    });
  });

  describe("Tool Registration", () => {
    it("should register all 4 tools via registerTool", async () => {
      createApexLogServer();

      expect(mockRegisterTool).toHaveBeenCalledTimes(4);
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_list_slow_operations",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_get_summary",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_list_limit_risks",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_execute_anonymous",
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("should always leave apexlog_execute_anonymous discoverable", async () => {
      createApexLogServer();

      const execAnonTool = registeredTools.get("apexlog_execute_anonymous")!;
      expect(execAnonTool.enabled).toBe(true);
      expect(execAnonTool.disable).not.toHaveBeenCalled();
    });

    it("should keep apexlog_execute_anonymous discoverable when apex execution is disabled", async () => {
      createApexLogServer({ apexExecutionDisabled: true });

      const execAnonTool = registeredTools.get("apexlog_execute_anonymous")!;
      expect(execAnonTool.enabled).toBe(true);
      expect(execAnonTool.disable).not.toHaveBeenCalled();
      expect(execAnonTool.config.description).toContain(
        "[DISABLED on this server]",
      );
    });

    it("should not mark the tool disabled in its description by default", async () => {
      createApexLogServer();

      const execAnonTool = registeredTools.get("apexlog_execute_anonymous")!;
      expect(execAnonTool.config.description).not.toContain("[DISABLED");
    });
  });

  describe("Tool Request Handling", () => {
    it("should handle apexlog_list_slow_operations tool correctly", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_list_slow_operations")!;
      const args = {
        logFilePath: "/path/to/test.log",
        limit: 5,
      };

      const result = await tool.callback(args, {} as any);

      expect(listSlowOperations).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockAnalysisResult);
    });

    it("should handle apexlog_get_summary tool correctly", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_get_summary")!;
      const args = { logFilePath: "/path/to/test.log" };

      const result = await tool.callback(args, {} as any);

      expect(getLogSummary).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockSummaryResult);
    });

    it("should handle apexlog_list_limit_risks tool correctly", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_list_limit_risks")!;
      const args = {
        logFilePath: "/path/to/test.log",
        threshold: 90,
      };

      const result = await tool.callback(args, {} as any);

      expect(listLimitRisks).toHaveBeenCalledWith(args);
      expect(result).toEqual(mockBottleneckResult);
    });

    it("should handle tool execution errors gracefully", async () => {
      const error = new Error("Tool execution failed");
      (
        listSlowOperations as jest.MockedFunction<
          typeof listSlowOperations
        >
      ).mockRejectedValueOnce(error);

      createApexLogServer();

      const tool = registeredTools.get("apexlog_list_slow_operations")!;

      await expect(
        tool.callback({ logFilePath: "/path/to/test.log" }, {} as any),
      ).rejects.toThrow("Tool execution failed");
    });

    it("should pass the default policy to apexlog_execute_anonymous", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_execute_anonymous")!;
      const args = { apex: "System.debug('test');" };

      const result = await tool.callback(args, {} as any);

      expect(executeAnonymous).toHaveBeenCalledWith(
        expect.anything(),
        args,
        expect.anything(),
        {
          allowProductionOrgs: false,
          apexExecutionDisabled: false,
          classificationCache: expect.any(Map),
          mintConfirmationState: expect.any(Function),
          consumeConfirmation: expect.any(Function),
        },
      );
      expect(result).toEqual(mockExecuteAnonymousResult);
    });

    it("should pass --allow-production-orgs through to apexlog_execute_anonymous", async () => {
      createApexLogServer({ allowProductionOrgs: true });

      const tool = registeredTools.get("apexlog_execute_anonymous")!;
      await tool.callback({ apex: "System.debug('test');" }, {} as any);

      expect(executeAnonymous).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ allowProductionOrgs: true }),
      );
    });

    it("should refuse apexlog_execute_anonymous under --no-apex-execution, and not load the tool", async () => {
      createApexLogServer({ apexExecutionDisabled: true });

      const tool = registeredTools.get("apexlog_execute_anonymous")!;
      const result = await tool.callback(
        { apex: "System.debug('test');" },
        {} as any,
      );

      expect(result).toEqual(
        expect.objectContaining({
          isError: true,
          content: [
            expect.objectContaining({
              text: expect.stringContaining("--no-apex-execution"),
            }),
          ],
        }),
      );
      expect(executeAnonymous).not.toHaveBeenCalled();
    });

    it("should reuse one classification cache across calls", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_execute_anonymous")!;
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
      runStdioServer();

      expect(serveStdio).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ legacy: "serve" }),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        "Apex Log MCP Server running on stdio",
      );
    });

    it("builds one server per connection from the factory", async () => {
      runStdioServer();

      const factory = (serveStdio as jest.Mock).mock.calls[0][0];
      expect(McpServer).not.toHaveBeenCalled();

      factory();
      factory();

      expect(McpServer).toHaveBeenCalledTimes(2);
    });

    it("should handle SIGINT and close server", async () => {
      runStdioServer();

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

      expect(mockHandleClose).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow for apexlog_list_slow_operations", async () => {
      createApexLogServer();

      // Verify all tools registered
      expect(registeredTools.size).toBe(4);

      // Test tool execution
      const tool = registeredTools.get("apexlog_list_slow_operations")!;
      const args = {
        logFilePath: "/path/to/test.log",
        limit: 10,
        minSelfMs: 1000,
      };

      const result = await tool.callback(args, {} as any);
      expect(result).toEqual(mockAnalysisResult);
      expect(listSlowOperations).toHaveBeenCalledWith(args);
    });

    it("should handle edge cases with malformed requests", async () => {
      createApexLogServer();

      (
        listSlowOperations as jest.MockedFunction<
          typeof listSlowOperations
        >
      ).mockRejectedValueOnce(new Error("Invalid arguments"));

      const tool = registeredTools.get("apexlog_list_slow_operations")!;

      await expect(tool.callback(null as any, {} as any)).rejects.toThrow(
        "Invalid arguments",
      );
    });
  });

  describe("Type Safety", () => {
    it("should handle typed arguments correctly", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_list_limit_risks")!;
      const args = {
        logFilePath: "/path/to/test.log",
        threshold: 50,
      };

      await tool.callback(args, {} as any);

      expect(listLimitRisks).toHaveBeenCalledWith(args);
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
