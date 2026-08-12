/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  listSlowOperations,
  listSlowOperationsToolConfig,
} from "./tools/listSlowOperations.js";
import {
  getLogSummary,
  getLogSummaryToolConfig,
} from "./tools/getLogSummary.js";
import {
  listLimitRisks,
  listLimitRisksToolConfig,
} from "./tools/listLimitRisks.js";
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
        version: "1.0.0",
        description:
          "Analyzes Salesforce Apex debug logs for performance bottlenecks, governor limit usage, and optimization opportunities.",
      },
      {
        capabilities: {
          tools: {},
        },
        instructions:
          "Analysis tools take an absolute path to a .log file and report every duration in milliseconds. Start with apexlog_get_summary, then go deeper with the other tools. Counts and limits are always reported, so a zero is a measured zero and not a missing value.",
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
    // SIGTERM as well as SIGINT. A supervised restart, a container stop, and a
    // client that ends a stdio server all send SIGTERM, and Node's default for
    // it is to exit without running any of this.
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  private registerTools(): void {
    this.server.registerTool(
      "apexlog_list_slow_operations",
      listSlowOperationsToolConfig,
      async (args) => listSlowOperations(args),
    );

    this.server.registerTool(
      "apexlog_get_summary",
      getLogSummaryToolConfig,
      async (args) => getLogSummary(args),
    );

    this.server.registerTool(
      "apexlog_list_limit_risks",
      listLimitRisksToolConfig,
      async (args) => listLimitRisks(args),
    );

    // Always registered, so agents can discover it regardless of configuration.
    // Whether a given call is permitted is decided per call, inside the handler.
    this.server.registerTool(
      "apexlog_execute_anonymous",
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
      "WARN --allowed-orgs is deprecated and ignored as of 2.0. apexlog_execute_anonymous is now\n" +
        "     always available; production orgs are gated per-call. See --allow-production-orgs.",
    );
  }

  return {
    allowProductionOrgs: values["allow-production-orgs"] ?? false,
    apexExecutionDisabled: values["no-apex-execution"] ?? false,
  };
}

export { ApexLogServer };
