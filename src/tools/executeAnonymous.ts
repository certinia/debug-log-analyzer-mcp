import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Connection, StateAggregator } from "@salesforce/core";
import { encode } from "@toon-format/toon";
import { getUserIdByUsername } from "../salesforce/users.js";
import {
  getOrCreateDebugLevelId,
  type DebugLevelInput,
} from "../salesforce/debugLevels.js";
import { ensureTraceFlag } from "../salesforce/traceFlags.js";
import { resolveOrg } from "../salesforce/connection.js";
import {
  classifyOrg,
  type OrgClassification,
} from "../salesforce/orgClassification.js";
import {
  authorizeExecution,
  APEX_EXECUTION_DISABLED_MESSAGE,
} from "../policy/orgExecutionPolicy.js";

type ApexLogRecord = {
  Id: string;
  DurationMilliseconds: number;
};

const LOG_LEVEL_ENUM = [
  "NONE",
  "ERROR",
  "WARN",
  "INFO",
  "DEBUG",
  "FINE",
  "FINER",
  "FINEST",
] as const;

const logLevelSchema = z.enum(LOG_LEVEL_ENUM);

function logLevelProperty(description: string) {
  return logLevelSchema.optional().describe(description);
}

export const executeAnonymousInputSchema = {
  apex: z.string().describe("The anonymous Apex to be executed"),
  targetOrg: z
    .string()
    .optional()
    .describe(
      "Alias or username of the target Salesforce org. Uses the project default if not specified.",
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory to save the debug log file. Defaults to .apex-log-mcp/ in the project root.",
    ),
  debugLevel: z
    .union([
      z
        .enum(["default", ...LOG_LEVEL_ENUM])
        .describe(
          'Use "default" to reset to defaults, or a log level (e.g. "FINEST") to set all categories to that level.',
        ),
      z
        .object({
          apexCode: logLevelProperty("Apex code log level (default: FINE)"),
          apexProfiling: logLevelProperty(
            "Apex profiling log level (default: FINE)",
          ),
          callout: logLevelProperty("Callout log level (default: DEBUG)"),
          database: logLevelProperty("Database log level (default: FINEST)"),
          nba: logLevelProperty(
            "NBA (Next Best Action) log level (default: INFO)",
          ),
          system: logLevelProperty("System log level (default: DEBUG)"),
          validation: logLevelProperty("Validation log level (default: DEBUG)"),
          visualforce: logLevelProperty(
            "Visualforce log level (default: FINE)",
          ),
          wave: logLevelProperty("Wave/Analytics log level (default: INFO)"),
          workflow: logLevelProperty("Workflow log level (default: FINE)"),
        })
        .describe(
          "Override specific log categories. Only specified categories are updated; others remain unchanged.",
        ),
    ])
    .optional()
    .describe(
      'Optional debug level configuration. Valid log levels: NONE, ERROR, WARN, INFO, DEBUG, FINE, FINER, FINEST. Pass "default" to reset, a single level string to set all categories, or an object with category overrides (apexCode, apexProfiling, callout, database, nba, system, validation, visualforce, wave, workflow).',
    ),
};

export type ExecuteAnonymousArgs = z.infer<
  z.ZodObject<typeof executeAnonymousInputSchema>
>;

export type ExecuteAnonymousPolicy = {
  allowProductionOrgs: boolean;
  apexExecutionDisabled: boolean;
  classificationCache: Map<string, OrgClassification>;
};

const EXECUTE_ANONYMOUS_DESCRIPTION =
  "Execute a snippet of anonymous Apex against an authenticated Salesforce org (via SF CLI). Saves the resulting debug log to a local file and returns a summary with the file path. Use the file path with get_apex_log_summary, analyze_apex_log_performance, or find_performance_bottlenecks for deeper analysis. Production orgs require per-call user confirmation or the --allow-production-orgs server flag.";

/**
 * The tool is always registered so that agents can discover it. When Apex
 * execution is disabled the description says so up front, which saves the agent
 * a call to find out.
 */
export function executeAnonymousToolConfig(apexExecutionDisabled = false) {
  return {
    title: "Execute Anonymous Apex",
    description: apexExecutionDisabled
      ? `[DISABLED on this server] ${EXECUTE_ANONYMOUS_DESCRIPTION} ${APEX_EXECUTION_DISABLED_MESSAGE}`
      : EXECUTE_ANONYMOUS_DESCRIPTION,
    inputSchema: executeAnonymousInputSchema,
    annotations: {
      title: "Execute Anonymous Apex",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

async function getProjectPath(server: McpServer): Promise<string | undefined> {
  try {
    const { roots } = await server.server.listRoots();
    const rootUri = roots[0]?.uri;
    return rootUri ? new URL(rootUri).pathname : undefined;
  } catch {
    return undefined;
  }
}

async function getAliasForUsername(
  username: string,
): Promise<string | undefined> {
  const stateAggregator = await StateAggregator.getInstance();
  return stateAggregator.aliases.get(username) ?? undefined;
}

function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

export async function executeAnonymous(
  server: McpServer,
  args: ExecuteAnonymousArgs,
  policy: ExecuteAnonymousPolicy,
) {
  const { apex, targetOrg, debugLevel } = args;

  // Short-circuit before touching the client or the org, so a server running with
  // --no-apex-execution makes no Salesforce calls at all.
  if (policy.apexExecutionDisabled) {
    return toolError(APEX_EXECUTION_DISABLED_MESSAGE);
  }

  const projectPath = await getProjectPath(server);

  const org = await resolveOrg(projectPath, targetOrg);
  const connection = org.getConnection();

  const username = connection.getUsername();
  if (!username) {
    throw new Error("Could not determine username from connection");
  }

  const alias = await getAliasForUsername(username);
  const orgLabel = alias ? `${username} (${alias})` : username;

  // Authorize before creating any DebugLevel or TraceFlag records, so a refused
  // call leaves the target org untouched.
  const { classification, unverifiedReason } = await classifyOrg(
    org,
    policy.classificationCache,
  );
  const decision = await authorizeExecution({
    server,
    classification,
    orgLabel,
    apex,
    allowProductionOrgs: policy.allowProductionOrgs,
    unverifiedReason,
  });

  if (!decision.allowed) {
    return toolError(decision.reason);
  }

  const userId = await getUserIdByUsername(connection, username);
  await validateTraceFlag(connection, userId, debugLevel);

  const apexResult = await connection.tooling.executeAnonymous(apex);

  if (!apexResult || !apexResult.compiled) {
    throw new Error(
      `Apex could not be compiled at line ${apexResult.line}, column ${apexResult.column}: ${apexResult.compileProblem}`,
    );
  }

  // Note: There's no way to get the specific log ID from executeAnonymous.
  // We retrieve the most recent log for this user, which could be incorrect
  // if another process creates a log between execution and this query.
  // Future enhancement: present a list of recent logs for user selection.
  const logRecord = (await connection
    .sobject("ApexLog")
    .findOne({ LogUserId: userId }, ["Id", "DurationMilliseconds"], {
      sort: { StartTime: -1 },
    })) as ApexLogRecord | null;

  if (!logRecord) {
    throw new Error(`Could not retrieve log from anonymous execution.`);
  }

  const logId = logRecord.Id;
  const logBody = await connection.request(`/sobjects/ApexLog/${logId}/Body/`);

  const outputDir =
    args.outputDir ?? path.join(projectPath ?? process.cwd(), ".apex-log-mcp");
  // Resolves to the first directory created, or undefined when it already existed,
  // which is exactly when the .gitignore tip below is worth its tokens.
  const createdDir = await fs.mkdir(outputDir, { recursive: true });

  const filePath = path.join(outputDir, `${logId}.log`);
  await fs.writeFile(filePath, logBody as string, "utf-8");
  const stats = await fs.stat(filePath);

  return {
    content: [
      {
        type: "text" as const,
        text: encode({
          filePath,
          fileSizeBytes: stats.size,
          org: orgLabel,
          orgType: classification,
          success: apexResult.success,
          ...(apexResult.exceptionMessage && {
            exceptionMessage: apexResult.exceptionMessage,
          }),
          durationMs: logRecord.DurationMilliseconds,
          ...(createdDir && {
            tip: "Add .apex-log-mcp/ to your .gitignore to avoid committing debug logs.",
          }),
        }),
      },
    ],
  };
}

async function validateTraceFlag(
  connection: Connection,
  userId: string,
  debugLevel?: DebugLevelInput,
) {
  const debugLevelId = await getOrCreateDebugLevelId(connection, debugLevel);
  await ensureTraceFlag(connection, userId, debugLevelId);
}
