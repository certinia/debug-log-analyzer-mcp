/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import packageJson from "../package.json";

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

jest.mock("../src/tools/searchEvents", () => ({
  searchEvents: jest.fn(),
  searchEventsToolConfig: {
    title: "Search Apex Log Events",
    description: "Search the events of an Apex debug log",
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
  executeAnonymousToolConfig: jest.fn((refusal?: string) => ({
    title: "Execute Anonymous Apex",
    description: refusal
      ? `[DISABLED on this server] Execute a snippet of anonymous Apex and retrieve the resulting log ${refusal}`
      : "Execute a snippet of anonymous Apex and retrieve the resulting log",
    inputSchema: {},
    annotations: {},
  })),
}));

// The org tools, loaded lazily by the server's own wiring.
jest.mock("../src/tools/listOrgLogs", () => ({ listOrgLogs: jest.fn() }));
jest.mock("../src/tools/getOrgLogs", () => ({ getOrgLogs: jest.fn() }));
jest.mock("../src/tools/createTraceFlag", () => ({ createTraceFlag: jest.fn() }));

// Import the tools after mocking
import { listSlowOperations } from "../src/tools/listSlowOperations";
import { getLogSummary } from "../src/tools/getLogSummary";
import { listLimitRisks } from "../src/tools/listLimitRisks";
import { searchEvents } from "../src/tools/searchEvents";
import { executeAnonymous } from "../src/tools/executeAnonymous";
import { listOrgLogs } from "../src/tools/listOrgLogs";
import { getOrgLogs } from "../src/tools/getOrgLogs";
import { createTraceFlag } from "../src/tools/createTraceFlag";
import { RELOGIN_HINT } from "../src/salesforce/authFailure";

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
    ).mockResolvedValue(mockAnalysisResult);
    (
      listLimitRisks as jest.MockedFunction<
        typeof listLimitRisks
      >
    ).mockResolvedValue(mockAnalysisResult);
    (
      searchEvents as jest.MockedFunction<typeof searchEvents>
    ).mockResolvedValue(mockAnalysisResult);
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
          version: packageJson.version,
          description: expect.any(String),
        },
        {
          capabilities: {
            tools: {},
          },
          enforceStrictCapabilities: true,
          // Said once for every tool that changes an org, not in each description.
          instructions: expect.stringContaining("ask the user first"),
          // Verifies a confirmation before any handler sees it.
          requestState: { verify: expect.any(Function) },
          cacheHints: {
            "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
          },
        },
      );
    });

    it.each([
      ["production orgs are allowed", { allowProductionOrgs: true }],
      ["no tool may change an org", { readOnly: true }],
    ])("should not tell the agent to confirm when %s", async (_, config) => {
      createApexLogServer(config);

      expect(McpServer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          instructions: expect.not.stringContaining("confirm"),
        }),
      );
    });

    it.each([
      ["--no-apex-execution", { apexExecutionDisabled: true }],
      ["--read-only", { readOnly: true }],
    ])("should not offer the definitions to a shared cache when %s changed them", async (_, config) => {
      createApexLogServer(config);

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
  });

  describe("Tool Registration", () => {
    it("should register all 8 tools via registerTool", async () => {
      createApexLogServer();

      expect(mockRegisterTool).toHaveBeenCalledTimes(8);
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
        "apexlog_search_events",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_execute_anonymous",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_list_org_logs",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_get_org_logs",
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockRegisterTool).toHaveBeenCalledWith(
        "apexlog_create_trace_flag",
        expect.any(Object),
        expect.any(Function),
      );
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

    // An agent that reads the list must not have to call a tool to learn it is refused.
    it("should mark both tools that change an org disabled under --read-only, and leave them discoverable", async () => {
      createApexLogServer({ readOnly: true });

      for (const name of ["apexlog_create_trace_flag", "apexlog_execute_anonymous"]) {
        const tool = registeredTools.get(name)!;
        expect(tool.enabled).toBe(true);
        expect(tool.config.description).toContain("[DISABLED on this server]");
        expect(tool.config.description).toContain("--read-only");
      }
      expect(registeredTools.get("apexlog_list_org_logs")!.config.description).not.toContain(
        "[DISABLED",
      );
    });

    it("should not mark the tool disabled in its description by default", async () => {
      createApexLogServer();

      const execAnonTool = registeredTools.get("apexlog_execute_anonymous")!;
      expect(execAnonTool.config.description).not.toContain("[DISABLED");
    });
  });

  describe("Tool Request Handling", () => {
    // An analysis tool takes its args and nothing else: no ctx, no org policy.
    it.each([
      ["apexlog_list_slow_operations", listSlowOperations],
      ["apexlog_get_summary", getLogSummary],
      ["apexlog_list_limit_risks", listLimitRisks],
      ["apexlog_search_events", searchEvents],
    ])("should pass only the args to %s, and its result back", async (name, handler) => {
      createApexLogServer();

      const args = { logFilePath: "/path/to/test.log" };
      const result = await registeredTools.get(name)!.callback(args, {} as any);

      expect(handler).toHaveBeenCalledWith(args);
      expect(result).toBe(mockAnalysisResult);
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

    // Every org tool reaches the deny list and the production gate through this policy.
    // A flag that refuses some tools must leave the others running.
    it.each([
      ["apexlog_list_org_logs", listOrgLogs, {}],
      ["apexlog_get_org_logs", getOrgLogs, { readOnly: true }],
      ["apexlog_create_trace_flag", createTraceFlag, { apexExecutionDisabled: true }],
      ["apexlog_execute_anonymous", executeAnonymous, {}],
    ])("should pass the args, ctx and org policy to %s", async (name, handler, flags) => {
      (handler as jest.Mock).mockResolvedValue(mockAnalysisResult);
      createApexLogServer({ allowProductionOrgs: true, ...flags });

      const args = { targetOrg: "psa" };
      const ctx = { mcpReq: {} };
      const result = await registeredTools.get(name)!.callback(args, ctx);

      expect(handler).toHaveBeenCalledWith(expect.anything(), args, ctx, {
        allowProductionOrgs: true,
        denyList: { patterns: [], types: [] },
        classificationCache: expect.any(Map),
        mintConfirmationState: expect.any(Function),
        consumeConfirmation: expect.any(Function),
      });
      expect(result).toBe(mockAnalysisResult);
    });

    it.each([
      ["apexlog_list_org_logs", listOrgLogs],
      ["apexlog_execute_anonymous", executeAnonymous],
    ])("should tell the agent to ask for a new login when %s finds the session dead", async (name, handler) => {
      const dead = Object.assign(new Error("Session expired or invalid"), {
        errorCode: "INVALID_SESSION_ID",
      });
      (handler as jest.Mock).mockRejectedValueOnce(dead);
      createApexLogServer();

      await expect(
        registeredTools.get(name)!.callback({ apex: "System.debug(1);" }, {} as any),
      ).rejects.toThrow(`Session expired or invalid ${RELOGIN_HINT}`);
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

    // --no-apex-execution alone left trace flags writable; --read-only must stop both writes.
    it.each([
      ["apexlog_create_trace_flag", createTraceFlag, { readOnly: true }],
      ["apexlog_execute_anonymous", executeAnonymous, { readOnly: true }],
      // The wider flag names itself, even when the narrower one is also set.
      [
        "apexlog_execute_anonymous",
        executeAnonymous,
        { readOnly: true, apexExecutionDisabled: true },
      ],
    ])("should refuse %s under --read-only, and not load the tool", async (name, handler, config) => {
      createApexLogServer(config);

      const result = await registeredTools.get(name)!.callback(
        { targetOrg: "psa", tracedEntity: "dev@example.com", apex: "System.debug(1);" },
        {} as any,
      );

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: "Tools that change an org are disabled by server configuration (--read-only). Other tools remain available.",
          },
        ],
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("should reuse one classification cache across calls", async () => {
      createApexLogServer();

      const tool = registeredTools.get("apexlog_execute_anonymous")!;
      await tool.callback({ apex: "System.debug(1);" }, {} as any);
      await tool.callback({ apex: "System.debug(2);" }, {} as any);

      const calls = (executeAnonymous as jest.Mock).mock.calls;
      expect(calls[0][3].classificationCache).toBe(
        calls[1][3].classificationCache,
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

    it.each(["SIGINT", "SIGTERM"])("should close the server on %s", async (signal) => {
      const processOnce = jest.spyOn(process, "once");
      runStdioServer();
      const signalCall = processOnce.mock.calls.find(
        (call: any) => call[0] === signal,
      );
      processOnce.mockRestore();
      expect(signalCall).toBeDefined();

      const signalHandler = signalCall![1] as () => Promise<void>;

      // The mocked process.exit throws.
      await expect(signalHandler()).rejects.toThrow("Process exit called");

      expect(mockHandleClose).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
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
      readOnly: false,
      denyList: { patterns: [], types: [] },
    });
  });

  it("should read --allow-production-orgs", () => {
    expect(parseServerConfig(["--allow-production-orgs"])).toEqual({
      allowProductionOrgs: true,
      apexExecutionDisabled: false,
      readOnly: false,
      denyList: { patterns: [], types: [] },
    });
  });

  it("should read --no-apex-execution", () => {
    expect(parseServerConfig(["--no-apex-execution"])).toEqual({
      allowProductionOrgs: false,
      apexExecutionDisabled: true,
      readOnly: false,
      denyList: { patterns: [], types: [] },
    });
  });

  it("should read --read-only", () => {
    expect(parseServerConfig(["--read-only"])).toEqual({
      allowProductionOrgs: false,
      apexExecutionDisabled: false,
      readOnly: true,
      denyList: { patterns: [], types: [] },
    });
  });

  it("should read --deny-orgs, comma-separated and repeated", () => {
    const { denyList } = parseServerConfig([
      "--deny-orgs",
      "A@x.com, b@x.com",
      "--deny-orgs",
      "prod-*@x.com",
    ]);

    expect(denyList?.patterns.map((pattern) => pattern.source)).toEqual([
      "A@x.com",
      "b@x.com",
      "prod-*@x.com",
    ]);
    expect(denyList?.types).toEqual([]);
  });

  it("should read type: entries in --deny-orgs as org types", () => {
    const { denyList } = parseServerConfig([
      "--deny-orgs",
      "type:production,euprod,type:unknown",
    ]);

    expect(denyList?.patterns.map((pattern) => pattern.source)).toEqual([
      "euprod",
    ]);
    expect(denyList?.types).toEqual(["production", "unknown"]);
  });

  // A pattern that matches nothing looks the same as one that has yet to match,
  // so only the closed set can be checked, and it is checked before startup.
  it("should refuse to start on a type: entry that is not an org type", () => {
    expect(() => parseServerConfig(["--deny-orgs", "type:prodction"])).toThrow(
      "'type:prodction' is not an org type",
    );
  });

  it("should still start when the deprecated --allowed-orgs is passed", () => {
    expect(
      parseServerConfig(["--allowed-orgs", "ALLOW_ALL_ORGS"]),
    ).toEqual({
      allowProductionOrgs: false,
      apexExecutionDisabled: false,
      readOnly: false,
      denyList: { patterns: [], types: [] },
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
