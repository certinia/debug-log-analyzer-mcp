#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  analyzeLogPerformance,
  analyzeLogPerformanceTool,
  AnalyzeLogArgs,
} from "./tools/analyzeLogPerformance.js";
import {
  getLogSummary,
  getLogSummaryTool,
  LogSummaryArgs,
} from "./tools/getLogSummary.js";
import {
  findPerformanceBottlenecks,
  findPerformanceBottlenecksTool,
  BottleneckArgs,
} from "./tools/findPerformanceBottlenecks.js";
import {
  executeAnonymous,
  executeAnonymousTool,
  ExecuteAnonymousArgs,
} from "./tools/executeAnonymous.js";

function parseArgs<T>(args: Record<string, unknown> | undefined): T {
  return (args ?? {}) as T;
}

class ApexLogServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "apex-log-mcp",
        version: "1.0.0",
        description:
          "Analyzes Salesforce Apex debug logs for performance bottlenecks, governor limit usage, and optimization opportunities.",
      },
      {
        capabilities: {
          tools: {},
        },
        instructions:
          "Use this server when you have an Apex debug log file to analyze, or when you need to execute anonymous Apex and inspect the resulting log. The log analysis tools accept absolute file paths and return structured JSON. Start with get_apex_log_summary for a quick overview, then use analyze_apex_log_performance or find_performance_bottlenecks for deeper analysis.",
      },
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    const shutdown = async () => {
      this.server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        analyzeLogPerformanceTool,
        getLogSummaryTool,
        findPerformanceBottlenecksTool,
        executeAnonymousTool,
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "analyze_apex_log_performance":
            return await analyzeLogPerformance(parseArgs<AnalyzeLogArgs>(args));
          case "get_apex_log_summary":
            return await getLogSummary(parseArgs<LogSummaryArgs>(args));
          case "find_performance_bottlenecks":
            return await findPerformanceBottlenecks(
              parseArgs<BottleneckArgs>(args),
            );
          case "execute_anonymous":
            return await executeAnonymous(
              this.server,
              parseArgs<ExecuteAnonymousArgs>(args),
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

    console.error("Apex Log MCP Server running on stdio");
  }
}

const server = new ApexLogServer();

server.run().catch(console.error);

export { ApexLogServer };
