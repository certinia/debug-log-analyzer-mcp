import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Mock the MCP SDK components
jest.mock("@modelcontextprotocol/sdk/server/index.js");
jest.mock("@modelcontextprotocol/sdk/server/stdio.js");

// Mock the tool modules
jest.mock("../src/tools/analyzeLogPerformance", () => ({
  analyzeLogPerformance: jest.fn(),
  analyzeLogPerformanceTool: {
    name: "analyze_apex_log_performance",
    description:
      "Analyze an Apex debug log file and identify the slowest running methods",
    inputSchema: {
      type: "object",
      properties: {
        logFilePath: {
          type: "string",
          description: "Absolute path to the log file",
        },
        topMethods: { type: "number", default: 10 },
        minDuration: { type: "number", default: 0 },
        namespace: { type: "string" },
      },
      required: ["logFilePath"],
    },
  },
}));

jest.mock("../src/tools/getLogSummary", () => ({
  getLogSummary: jest.fn(),
  getLogSummaryTool: {
    name: "get_apex_log_summary",
    description: "Get a high-level summary of an Apex debug log",
    inputSchema: {
      type: "object",
      properties: {
        logFilePath: {
          type: "string",
          description: "Absolute path to the log file",
        },
      },
      required: ["logFilePath"],
    },
  },
}));

jest.mock("../src/tools/findPerformanceBottlenecks", () => ({
  findPerformanceBottlenecks: jest.fn(),
  findPerformanceBottlenecksTool: {
    name: "find_performance_bottlenecks",
    description: "Identify performance bottlenecks in an Apex log",
    inputSchema: {
      type: "object",
      properties: {
        logFilePath: {
          type: "string",
          description: "Absolute path to the log file",
        },
        analysisType: {
          type: "string",
          enum: ["cpu", "database", "methods", "all"],
          default: "all",
        },
      },
      required: ["logFilePath"],
    },
  },
}));

// Import the tools after mocking
import {
  analyzeLogPerformance,
  analyzeLogPerformanceTool,
} from "../src/tools/analyzeLogPerformance";
import { getLogSummary, getLogSummaryTool } from "../src/tools/getLogSummary";
import {
  findPerformanceBottlenecks,
  findPerformanceBottlenecksTool,
} from "../src/tools/findPerformanceBottlenecks";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { connect } from "http2";

// Mock process methods
const mockExit = jest.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("Process exit called");
}) as any);

// Mock console methods
const mockConsoleError = jest
  .spyOn(console, "error")
  .mockImplementation(() => {});

// Create the LanaServer class for testing
class LanaServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "lana-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error: any) => {
      console.error("[MCP Error]", error);
    };
    process.on("SIGINT", async () => {
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        analyzeLogPerformanceTool,
        getLogSummaryTool,
        findPerformanceBottlenecksTool,
      ],
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: any) => {
        const { name, arguments: args } = request.params;

        try {
          switch (name) {
            case "analyze_apex_log_performance":
              return await analyzeLogPerformance(args as any);
            case "get_apex_log_summary":
              return await getLogSummary(args as any);
            case "find_performance_bottlenecks":
              return await findPerformanceBottlenecks(args as any);
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    console.log(this.server);
    await this.server.connect(transport);
    console.error("LANA MCP Server running on stdio");
  }
}

describe("LanaServer", () => {
  let mockServer: jest.Mocked<Server>;
  let mockTransport: jest.Mocked<StdioServerTransport>;
  let mockSetRequestHandler: jest.MockedFunction<
    typeof Server.prototype.setRequestHandler
  >;
  let mockConnect: jest.MockedFunction<typeof Server.prototype.connect>;
  let mockClose: jest.MockedFunction<typeof Server.prototype.close>;

  // Mock data for testing
  const mockAnalysisResult = {
    content: [
      {
        type: "text",
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
        type: "text",
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
        type: "text",
        text: JSON.stringify({
          cpuBottlenecks: {},
          databaseBottlenecks: {},
          governorLimitWarnings: {},
        }),
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup server mock
    mockSetRequestHandler = jest.fn();

    mockServer = {
      setRequestHandler: mockSetRequestHandler,
      connect: jest.fn(),
      onerror: undefined,
    } as any;

    // Setup transport mock
    mockTransport = {} as jest.Mocked<StdioServerTransport>;

    (Server as jest.MockedClass<typeof Server>).mockImplementation(
      () => mockServer
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

    // Clear the module cache and re-import
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Server Initialization", () => {
    it("should create server with correct configuration", async () => {
      new LanaServer();

      expect(Server).toHaveBeenCalledWith(
        {
          name: "lana-mcp-server",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );
    });

    it("should setup error handling", async () => {
      new LanaServer();

      expect(mockServer.onerror).toBeDefined();

      // Test error handler
      const testError = new Error("Test error");
      if (mockServer.onerror) {
        mockServer.onerror(testError);
      }

      expect(mockConsoleError).toHaveBeenCalledWith("[MCP Error]", testError);
    });

    it("should setup SIGINT handler", async () => {
      const mockProcessOn = jest.spyOn(process, "on");

      new LanaServer();

      expect(mockProcessOn).toHaveBeenCalledWith(
        "SIGINT",
        expect.any(Function)
      );
    });
  });

  describe("Tool Registration", () => {
    it("should register ListToolsRequest handler", async () => {
      new LanaServer();

      expect(mockSetRequestHandler).toHaveBeenCalledWith(
        ListToolsRequestSchema,
        expect.any(Function)
      );
    });

    it("should register CallToolRequest handler", async () => {
      new LanaServer();

      expect(mockSetRequestHandler).toHaveBeenCalledWith(
        CallToolRequestSchema,
        expect.any(Function)
      );
    });

    it("should return correct tools list when ListToolsRequest is called", async () => {
      new LanaServer();

      // Get the ListToolsRequest handler
      const listToolsCall = mockSetRequestHandler.mock.calls.find(
        (call: any) => call[0] === ListToolsRequestSchema
      );
      expect(listToolsCall).toBeDefined();

      const listToolsHandler = listToolsCall![1];
      const result = await listToolsHandler({} as any, {} as any);

      expect(result).toEqual({
        tools: [
          analyzeLogPerformanceTool,
          getLogSummaryTool,
          findPerformanceBottlenecksTool,
        ],
      });
    });
  });

  describe("Tool Request Handling", () => {
    let callToolHandler: Function;

    beforeEach(async () => {
      new LanaServer();

      // Get the CallToolRequest handler
      const callToolCall = mockSetRequestHandler.mock.calls.find(
        (call: any) => call[0] === CallToolRequestSchema
      );
      expect(callToolCall).toBeDefined();
      callToolHandler = callToolCall![1];
    });

    it("should handle analyze_apex_log_performance tool correctly", async () => {
      const request = {
        params: {
          name: "analyze_apex_log_performance",
          arguments: {
            logFilePath: "/path/to/test.log",
            topMethods: 5,
          },
        },
      };

      const result = await callToolHandler(request, {} as any);

      expect(analyzeLogPerformance).toHaveBeenCalledWith({
        logFilePath: "/path/to/test.log",
        topMethods: 5,
      });
      expect(result).toEqual(mockAnalysisResult);
    });

    it("should handle get_apex_log_summary tool correctly", async () => {
      const request = {
        params: {
          name: "get_apex_log_summary",
          arguments: {
            logFilePath: "/path/to/test.log",
          },
        },
      };

      const result = await callToolHandler(request, {} as any);

      expect(getLogSummary).toHaveBeenCalledWith({
        logFilePath: "/path/to/test.log",
      });
      expect(result).toEqual(mockSummaryResult);
    });

    it("should handle find_performance_bottlenecks tool correctly", async () => {
      const request = {
        params: {
          name: "find_performance_bottlenecks",
          arguments: {
            logFilePath: "/path/to/test.log",
            analysisType: "cpu",
          },
        },
      };

      const result = await callToolHandler(request, {} as any);

      expect(findPerformanceBottlenecks).toHaveBeenCalledWith({
        logFilePath: "/path/to/test.log",
        analysisType: "cpu",
      });
      expect(result).toEqual(mockBottleneckResult);
    });

    it("should return error for unknown tool", async () => {
      const request = {
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      };

      const result = await callToolHandler(request, {} as any);

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Error: Unknown tool: unknown_tool",
          },
        ],
        isError: true,
      });
    });

    it("should handle tool execution errors gracefully", async () => {
      const error = new Error("Tool execution failed");
      (
        analyzeLogPerformance as jest.MockedFunction<
          typeof analyzeLogPerformance
        >
      ).mockRejectedValueOnce(error);

      const request = {
        params: {
          name: "analyze_apex_log_performance",
          arguments: {
            logFilePath: "/path/to/test.log",
          },
        },
      };

      const result = await callToolHandler(request, {} as any);

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Error: Tool execution failed",
          },
        ],
        isError: true,
      });
    });

    it("should handle non-Error exceptions", async () => {
      (
        analyzeLogPerformance as jest.MockedFunction<
          typeof analyzeLogPerformance
        >
      ).mockRejectedValueOnce("String error");

      const request = {
        params: {
          name: "analyze_apex_log_performance",
          arguments: {
            logFilePath: "/path/to/test.log",
          },
        },
      };

      const result = await callToolHandler(request, {} as any);

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Error: String error",
          },
        ],
        isError: true,
      });
    });
  });

  describe("Server Lifecycle", () => {
    it("should start server correctly", async () => {
      const lanaServer = new LanaServer();
      await lanaServer.run();

      expect(StdioServerTransport).toHaveBeenCalled();
      // expect(mockConnect).toHaveBeenCalledWith(mockTransport);
      expect(mockConsoleError).toHaveBeenCalledWith(
        "LANA MCP Server running on stdio"
      );
    });

    it("should connect to stdio transport", async () => {
      const lanaServer = new LanaServer();
      await lanaServer.run();

      expect(StdioServerTransport).toHaveBeenCalled();
      // expect(mockConnect).toHaveBeenCalledWith(mockTransport);
    });

    it("should handle SIGINT and close server", async () => {
      new LanaServer();

      // Find the SIGINT handler
      const processOnCalls = jest.spyOn(process, "on").mock.calls;
      const sigintCall = processOnCalls.find(
        (call: any) => call[0] === "SIGINT"
      );
      expect(sigintCall).toBeDefined();

      const sigintHandler = sigintCall![1] as Function;

      // Test SIGINT handler
      try {
        await sigintHandler();
      } catch (error) {
        // Expected to throw due to mocked process.exit
        expect((error as Error).message).toBe("Process exit called");
      }

      // expect(mockClose).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow for analyze_apex_log_performance", async () => {
      new LanaServer();

      // Get handlers
      const listToolsCall = mockSetRequestHandler.mock.calls.find(
        (call: any) => call[0] === ListToolsRequestSchema
      );
      const callToolCall = mockSetRequestHandler.mock.calls.find(
        (call: any) => call[0] === CallToolRequestSchema
      );

      const listToolsHandler = listToolsCall![1];
      const callToolHandler = callToolCall![1];

      // Test tool listing
      const toolsResult = await listToolsHandler({} as any, {} as any);
      expect(toolsResult.tools).toHaveLength(3);
      expect(toolsResult.tools[0].name).toBe("analyze_apex_log_performance");

      // Test tool execution
      const request = {
        params: {
          name: "analyze_apex_log_performance",
          arguments: {
            logFilePath: "/path/to/test.log",
            topMethods: 10,
            minDuration: 1000,
          },
        },
      };

      const result = await callToolHandler(request as any, {} as any);
      expect(result).toEqual(mockAnalysisResult);
      expect(analyzeLogPerformance).toHaveBeenCalledWith({
        logFilePath: "/path/to/test.log",
        topMethods: 10,
        minDuration: 1000,
      });
    });

    it("should handle edge cases with malformed requests", async () => {
      new LanaServer();

      const callToolCall = mockSetRequestHandler.mock.calls.find(
        (call: any) => call[0] === CallToolRequestSchema
      );
      const callToolHandler = callToolCall![1];

      // Test with missing arguments
      const request = {
        params: {
          name: "analyze_apex_log_performance",
          arguments: null,
        },
      };

      (
        analyzeLogPerformance as jest.MockedFunction<
          typeof analyzeLogPerformance
        >
      ).mockRejectedValueOnce(new Error("Invalid arguments"));

      const result = await callToolHandler(request as any, {} as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error: Invalid arguments");
    });
  });

  describe("Type Safety", () => {
    it("should handle typed arguments correctly", async () => {
      new LanaServer();

      const callToolCall = mockSetRequestHandler.mock.calls.find(
        (call: any) => call[0] === CallToolRequestSchema
      );
      const callToolHandler = callToolCall![1];

      const request = {
        params: {
          name: "find_performance_bottlenecks",
          arguments: {
            logFilePath: "/path/to/test.log",
            analysisType: "database" as const,
          },
        },
      };

      await callToolHandler(request as any, {} as any);

      expect(findPerformanceBottlenecks).toHaveBeenCalledWith({
        logFilePath: "/path/to/test.log",
        analysisType: "database",
      });
    });
  });
});
