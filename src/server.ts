/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
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
import { limitUnitsClause } from "./tools/responseShaping.js";
import {
  executeAnonymousToolConfig,
  type ExecuteAnonymousArgs,
} from "./tools/executeAnonymousDefinition.js";
import {
  apexExecutionRefusal,
  CONFIRMATION_TTL_SECONDS,
  createConfirmationLedger,
  type ConfirmationState,
} from "./policy/orgExecutionPolicy.js";
import type { OrgClassification } from "./salesforce/orgClassification.js";

export type ServerConfig = {
  allowProductionOrgs?: boolean;
  apexExecutionDisabled?: boolean;
};

// An org id maps to one classification for the life of the process, so this
// outlives the per-connection server built below.
const classificationCache = new Map<string, OrgClassification>();

// A production-org confirmation travels back through the client, so it is signed
// here and verified before any handler sees it. The key is per process, which is
// enough because one process serves every round of a stdio flow, and better than
// a fixed key: a confirmation cannot outlive the server that asked for it.
const confirmationCodec = createRequestStateCodec<ConfirmationState>({
  key: randomBytes(32),
  ttlSeconds: CONFIRMATION_TTL_SECONDS,
  // The spec's user-binding MUST for state that decides authorization: a
  // confirmation given in one session, or for another method, is not this call's
  // to spend. The tag is HMACed, so the session id never reaches the client.
  bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.sessionId ?? ""}`,
});

// One confirmation authorizes one run, so the answers spent are remembered for
// as long as the signature that carries them stays valid.
const consumeConfirmation = createConfirmationLedger();

/**
 * Whether this server's configuration reaches the tool definitions.
 *
 * Two servers that answer `tools/list` differently must not share a cached
 * answer, so extend this whenever a new option changes a name, a schema or a
 * description. `--no-apex-execution` does: it stamps a disabled marker into
 * `apexlog_execute_anonymous`.
 */
function definitionsVaryByConfig(config: Required<ServerConfig>): boolean {
  return config.apexExecutionDisabled;
}

export function createApexLogServer(config: ServerConfig = {}): McpServer {
  const allowProductionOrgs = config.allowProductionOrgs ?? false;
  const apexExecutionDisabled = config.apexExecutionDisabled ?? false;
  const server = new McpServer(
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
      instructions: `Analysis tools take an absolute path to a .log file. Every duration is milliseconds, and ${limitUnitsClause()}. Start with apexlog_get_summary, then go deeper with the other tools. Counts and limits are always reported, so a zero is a measured zero and not a missing value.`,
      // Rejects a forged, altered or expired confirmation before the handler
      // runs, and hands the handler the decoded payload.
      requestState: { verify: confirmationCodec.verify },
      // The tool definitions are fixed for the life of the process, so an hour
      // is safe whatever they say. "public" additionally claims one copy serves
      // every caller, which holds only while the definitions are a pure
      // function of the code — see definitionsVaryByConfig.
      cacheHints: {
        "tools/list": {
          ttlMs: 3_600_000,
          cacheScope: definitionsVaryByConfig({
            allowProductionOrgs,
            apexExecutionDisabled,
          })
            ? "private"
            : "public",
        },
      },
    },
  );

  server.registerTool(
    "apexlog_list_slow_operations",
    listSlowOperationsToolConfig,
    async (args) => listSlowOperations(args),
  );

  server.registerTool(
    "apexlog_get_summary",
    getLogSummaryToolConfig,
    async (args) => getLogSummary(args),
  );

  server.registerTool(
    "apexlog_list_limit_risks",
    listLimitRisksToolConfig,
    async (args) => listLimitRisks(args),
  );

  // Always registered, so agents can discover it regardless of configuration.
  // Whether a given call is permitted is decided per call, inside the handler.
  server.registerTool(
    "apexlog_execute_anonymous",
    executeAnonymousToolConfig(apexExecutionDisabled),
    async (args, ctx) => {
      const refused = apexExecutionRefusal(apexExecutionDisabled);
      if (refused) {
        return refused;
      }
      // Loaded here and not at the top of the file: the tool reaches
      // `@salesforce/core`, and a session that only reads logs must not pay
      // the 250 ms it costs to load.
      const { executeAnonymous } = await import("./tools/executeAnonymous.js");
      return executeAnonymous(server, args as ExecuteAnonymousArgs, ctx, {
        allowProductionOrgs,
        apexExecutionDisabled,
        classificationCache,
        mintConfirmationState: (payload, ctx) =>
          confirmationCodec.mint(payload, ctx),
        consumeConfirmation,
      });
    },
  );

  return server;
}

/**
 * Serve MCP over stdio.
 *
 * One server per connection, built after the opening exchange has chosen the
 * protocol era. `legacy: "serve"` is the SDK default, stated here because
 * dropping 2025-era clients would be a breaking change.
 */
export function runStdioServer(config: ServerConfig = {}): void {
  const handle = serveStdio(() => createApexLogServer(config), {
    legacy: "serve",
    onerror: (error) => console.error("[MCP Error]", error),
  });

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  // SIGTERM as well as SIGINT. A supervised restart, a container stop, and a
  // client that ends a stdio server all send SIGTERM, and Node's default for
  // it is to exit without running any of this.
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.error("Apex Log MCP Server running on stdio");
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
