#!/usr/bin/env node

/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  analyzeLogPerformance,
  analyzeLogPerformanceToolConfig,
} from "./tools/analyzeLogPerformance.js";
import {
  getLogSummary,
  getLogSummaryToolConfig,
} from "./tools/getLogSummary.js";
import {
  findPerformanceBottlenecks,
  findPerformanceBottlenecksToolConfig,
} from "./tools/findPerformanceBottlenecks.js";
import {
  executeAnonymous,
  executeAnonymousToolConfig,
  type ExecuteAnonymousArgs,
} from "./tools/executeAnonymous.js";

class ApexLogServer {
  private server: McpServer;
  private allowedOrgs: string[];
  private execAnonTool: RegisteredTool;

  constructor(allowedOrgs: string[] = []) {
    this.allowedOrgs = allowedOrgs;
    this.server = new McpServer(
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
          "Use this server when you have an Apex debug log file to analyze, or when you need to execute anonymous Apex and inspect the resulting log. The log analysis tools accept absolute file paths and return structured data with all durations in milliseconds. Start with get_apex_log_summary for a quick overview, then use analyze_apex_log_performance or find_performance_bottlenecks for deeper analysis. The execute_anonymous tool saves the debug log to a local file and returns a summary with the file path — pass that path to the analysis tools.",
      },
    );

    this.execAnonTool = this.registerTools();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    const shutdown = async () => {
      this.server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
  }

  private registerTools(): RegisteredTool {
    this.server.registerTool(
      "analyze_apex_log_performance",
      analyzeLogPerformanceToolConfig,
      async (args) => analyzeLogPerformance(args),
    );

    this.server.registerTool(
      "get_apex_log_summary",
      getLogSummaryToolConfig,
      async (args) => getLogSummary(args),
    );

    this.server.registerTool(
      "find_performance_bottlenecks",
      findPerformanceBottlenecksToolConfig,
      async (args) => findPerformanceBottlenecks(args),
    );

    const execAnon = this.server.registerTool(
      "execute_anonymous",
      executeAnonymousToolConfig,
      async (args) => {
        if (this.allowedOrgs.length === 0) {
          throw new Error(
            "execute_anonymous is disabled. Configure --allowed-orgs to enable it.",
          );
        }
        return executeAnonymous(
          this.server,
          args as ExecuteAnonymousArgs,
          this.allowedOrgs,
        );
      },
    );

    if (this.allowedOrgs.length === 0) {
      execAnon.disable();
    }

    return execAnon;
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

    if (this.allowedOrgs.length > 0) {
      this.execAnonTool.enable();
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("Apex Log MCP Server running on stdio");
  }
}

const server = new ApexLogServer();
server.run().catch(console.error);

export { ApexLogServer };
