/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import type { OrgClassification } from "./salesforce/orgClassification.js";

export type ServerConfig = {
  allowProductionOrgs?: boolean;
  apexExecutionDisabled?: boolean;
};

class ApexLogServer {
  private server: McpServer;
  private allowProductionOrgs: boolean;
  private apexExecutionDisabled: boolean;
  private classificationCache = new Map<string, OrgClassification>();

  constructor(config: ServerConfig = {}) {
    this.allowProductionOrgs = config.allowProductionOrgs ?? false;
    this.apexExecutionDisabled = config.apexExecutionDisabled ?? false;
    this.server = new McpServer(
      {
        name: "apex-log-mcp",
        version: "2.0.0",
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

    this.registerTools();
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

  private registerTools(): void {
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

    // Always registered, so agents can discover it regardless of configuration.
    // Whether a given call is permitted is decided per call, inside the handler.
    this.server.registerTool(
      "execute_anonymous",
      executeAnonymousToolConfig(this.apexExecutionDisabled),
      async (args) =>
        executeAnonymous(this.server, args as ExecuteAnonymousArgs, {
          allowProductionOrgs: this.allowProductionOrgs,
          apexExecutionDisabled: this.apexExecutionDisabled,
          classificationCache: this.classificationCache,
        }),
    );
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("Apex Log MCP Server running on stdio");
  }
}

/**
 * Parse CLI configuration.
 *
 * `--allowed-orgs` is deprecated and ignored, but is still declared here because
 * parseArgs is strict: leaving it out would make existing client configurations
 * fail to start.
 */
export function parseServerConfig(argv: string[]): ServerConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      "allowed-orgs": { type: "string" },
      "allow-production-orgs": { type: "boolean" },
      "no-apex-execution": { type: "boolean" },
    },
  });

  if (values["allowed-orgs"] !== undefined) {
    console.error(
      "WARN --allowed-orgs is deprecated and ignored as of 2.0. execute_anonymous is now\n" +
        "     always available; production orgs are gated per-call. See --allow-production-orgs.",
    );
  }

  return {
    allowProductionOrgs: values["allow-production-orgs"] ?? false,
    apexExecutionDisabled: values["no-apex-execution"] ?? false,
  };
}

export { ApexLogServer };
