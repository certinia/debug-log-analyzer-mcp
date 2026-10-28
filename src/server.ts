/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  McpServer,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { analysisTools } from "./tools/analysisTools.js";
import { withReloginHint } from "./salesforce/authFailure.js";
import { limitUnitsClause } from "./tools/responseShaping.js";
import { toolError } from "./errors.js";
import { executeAnonymousTool } from "./tools/executeAnonymousDefinition.js";
import { createTraceFlagTool } from "./tools/traceFlagsDefinition.js";
import { getOrgLogsTool, listOrgLogsTool } from "./tools/orgLogsDefinition.js";
import {
  APEX_EXECUTION_DISABLED_MESSAGE,
  CONFIRMATION_TTL_SECONDS,
  createConfirmationLedger,
  READ_ONLY_MESSAGE,
  type ConfirmationState,
} from "./policy/orgExecutionPolicy.js";
import { compileDenyList, type DenyList } from "./policy/orgDenyList.js";
import type { OrgClassification } from "./salesforce/orgClassification.js";
import type { OpenOrg } from "./salesforce/orgAccess.js";
import packageJson from "../package.json" with { type: "json" };

export type ServerConfig = {
  allowProductionOrgs?: boolean;
  apexExecutionDisabled?: boolean;
  readOnly?: boolean;
  denyList?: DenyList;
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
 * description. `--no-apex-execution` and `--read-only` do: they stamp a
 * disabled marker into the tools they refuse.
 */
function definitionsVaryByConfig(config: Required<ServerConfig>): boolean {
  return config.apexExecutionDisabled || config.readOnly;
}

export function createApexLogServer(config: ServerConfig = {}): McpServer {
  const allowProductionOrgs = config.allowProductionOrgs ?? false;
  const apexExecutionDisabled = config.apexExecutionDisabled ?? false;
  const readOnly = config.readOnly ?? false;
  const denyList = config.denyList ?? { patterns: [], types: [] };
  // The refusal each tool that changes an org gives every call, or undefined.
  // --read-only covers more than --no-apex-execution, so its message wins.
  const orgWriteRefusal = readOnly ? READ_ONLY_MESSAGE : undefined;
  const apexRefusal =
    orgWriteRefusal ??
    (apexExecutionDisabled ? APEX_EXECUTION_DISABLED_MESSAGE : undefined);
  const server = new McpServer(
    {
      name: "apex-log-mcp",
      version: packageJson.version,
      description:
        "Analyzes Salesforce Apex debug logs for bottlenecks and governor limit usage; runs Apex, fetches logs and creates trace flags in an org.",
    },
    {
      capabilities: {
        tools: {},
      },
      // Never send a request the client did not declare: it may never be answered.
      enforceStrictCapabilities: true,
      instructions: `Analysis tools take an absolute .log path and never contact an org. Every duration is milliseconds, and ${limitUnitsClause()}. Start with apexlog_get_summary, then go deeper. A zero count or limit is measured, not missing.${allowProductionOrgs || readOnly ? "" : " Tools that change a production org, or one of unknown type, ask the user first, or refuse if the client cannot ask."}`,
      // Rejects a forged, altered or expired confirmation before the handler
      // runs, and hands the handler the decoded payload.
      requestState: { verify: confirmationCodec.verify },
      // The tool definitions are fixed for the life of the process, so an hour
      // is safe whatever they say. "public" additionally claims one copy serves
      // every caller, which holds only while the definitions are a pure
      // function of the code - see definitionsVaryByConfig.
      cacheHints: {
        "tools/list": {
          ttlMs: 3_600_000,
          cacheScope: definitionsVaryByConfig({
            allowProductionOrgs,
            apexExecutionDisabled,
            readOnly,
            denyList,
          })
            ? "private"
            : "public",
        },
      },
    },
  );

  for (const tool of analysisTools) {
    server.registerTool(tool.name, tool.config, tool.handle);
  }

  // Every org tool is held to the same deny list and production gate.
  const orgAccessPolicy = {
    allowProductionOrgs,
    denyList,
    classificationCache,
    mintConfirmationState: (payload: ConfirmationState, ctx: ServerContext) =>
      confirmationCodec.mint(payload, ctx),
    consumeConfirmation,
  };

  // The org tools load lazily: they reach
  // `@salesforce/core`, which a session that only reads logs must not pay for.
  // A refusal, set for a tool that changes an org, answers every call, and
  // the tool never loads.
  const registerOrgTool = <S extends StandardSchemaWithJSON>(
    {
      name,
      config,
      refusal,
    }: {
      name: string;
      config: {
        title: string;
        description: string;
        inputSchema: S;
        annotations: ToolAnnotations;
      };
      refusal?: string;
    },
    load: () => Promise<
      (
        args: StandardSchemaWithJSON.InferOutput<S>,
        open: OpenOrg,
        ctx: ServerContext,
      ) => Promise<CallToolResult | InputRequiredResult>
    >,
  ): void => {
    const handle = async (
      args: StandardSchemaWithJSON.InferOutput<S>,
      ctx: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
      if (refusal !== undefined) {
        return toolError(refusal);
      }
      const { bindOpenOrg } = await import("./salesforce/orgAccess.js");
      const open = bindOpenOrg(server, ctx, name, orgAccessPolicy);
      // A dead login can fail any org call, not only the connect.
      try {
        return await (await load())(args, open, ctx);
      } catch (error) {
        throw withReloginHint(error);
      }
    };
    // The SDK's callback type is conditional on S, so it cannot be resolved here; `handle` is that type for any S.
    server.registerTool(name, config, handle as ToolCallback<S>);
  };

  registerOrgTool(
    listOrgLogsTool,
    async () => (await import("./tools/listOrgLogs.js")).listOrgLogs,
  );
  registerOrgTool(
    getOrgLogsTool,
    async () => (await import("./tools/getOrgLogs.js")).getOrgLogs,
  );
  registerOrgTool(
    createTraceFlagTool(orgWriteRefusal),
    async () => (await import("./tools/createTraceFlag.js")).createTraceFlag,
  );
  // Always registered, so agents can discover it regardless of configuration.
  // A flag refuses every call here; otherwise the handler decides per call.
  registerOrgTool(
    executeAnonymousTool(apexRefusal),
    async () => (await import("./tools/executeAnonymous.js")).executeAnonymous,
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
 *
 * Throws on a `--deny-orgs` `type:` entry that names no org type, so a typo
 * stops the server rather than leaving a deny that silently never matches.
 */
export function parseServerConfig(argv: string[]): ServerConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      "allowed-orgs": { type: "string" },
      "allow-production-orgs": { type: "boolean" },
      "no-apex-execution": { type: "boolean" },
      "read-only": { type: "boolean" },
      "deny-orgs": { type: "string", multiple: true },
    },
  });
  const denyList = compileDenyList(values["deny-orgs"] ?? []);

  if (values["allowed-orgs"] !== undefined) {
    console.error(
      "WARN --allowed-orgs is deprecated and ignored as of 2.0. apexlog_execute_anonymous is now\n" +
        "     always available; production orgs are gated per-call. See --allow-production-orgs.",
    );
  }

  return {
    allowProductionOrgs: values["allow-production-orgs"] ?? false,
    apexExecutionDisabled: values["no-apex-execution"] ?? false,
    readOnly: values["read-only"] ?? false,
    denyList,
  };
}
