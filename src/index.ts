#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { parseArgs } from "node:util";
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

function parseToolArgs<T>(args: Record<string, unknown> | undefined): T {
  return (args ?? {}) as T;
}

class ApexLogServer {
  private server: Server;
  private allowedOrgs: string[];

  constructor(allowedOrgs: string[] = []) {
    this.allowedOrgs = allowedOrgs;
    this.server = new Server(
      {
        name: "apex-log-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
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
        ...(this.allowedOrgs.length > 0 ? [executeAnonymousTool] : []),
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "analyze_apex_log_performance":
            return await analyzeLogPerformance(
              parseToolArgs<AnalyzeLogArgs>(args),
            );
          case "get_apex_log_summary":
            return await getLogSummary(parseToolArgs<LogSummaryArgs>(args));
          case "find_performance_bottlenecks":
            return await findPerformanceBottlenecks(
              parseToolArgs<BottleneckArgs>(args),
            );
          case "execute_anonymous":
            if (this.allowedOrgs.length === 0) {
              throw new Error(
                "execute_anonymous is disabled. Configure --allowed-orgs to enable it.",
              );
            }
            return await executeAnonymous(
              this.server,
              parseToolArgs<ExecuteAnonymousArgs>(args),
              this.allowedOrgs,
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
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "allowed-orgs": { type: "string" },
      },
    });

    this.allowedOrgs = values["allowed-orgs"]
      ? values["allowed-orgs"].split(",").map((org) => org.trim())
      : [];

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("Apex Log MCP Server running on stdio");
  }
}

const server = new ApexLogServer();
server.run().catch(console.error);

export { ApexLogServer };
