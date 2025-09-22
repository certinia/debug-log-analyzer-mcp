#!/usr/bin/env node

/**
 * LANA MCP Server - Model Context Protocol server for Apex Log Analysis
 *
 * This server provides tools for analyzing Salesforce Apex debug logs,
 * specifically focused on identifying performance bottlenecks and slow methods.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types";
import {
  analyzeLogPerformance,
  analyzeLogPerformanceTool,
  AnalyzeLogArgs,
} from "./tools/analyzeLogPerformance";
import {
  getLogSummary,
  getLogSummaryTool,
  LogSummaryArgs,
} from "./tools/getLogSummary";
import {
  findPerformanceBottlenecks,
  findPerformanceBottlenecksTool,
  BottleneckArgs,
} from "./tools/findPerformanceBottlenecks";

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
    this.server.onerror = (error) => {
       
      console.error("[MCP Error]", error);
    };
    process.on("SIGINT", async () => {
      this.server.close();
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

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "analyze_apex_log_performance":
            return await analyzeLogPerformance(
              args as unknown as AnalyzeLogArgs
            );
          case "get_apex_log_summary":
            return await getLogSummary(args as unknown as LogSummaryArgs);
          case "find_performance_bottlenecks":
            return await findPerformanceBottlenecks(
              args as unknown as BottleneckArgs
            );
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
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
     
    console.error("LANA MCP Server running on stdio");
  }
}

const server = new LanaServer();
 
server.run().catch(console.error);

export { LanaServer };
