import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Connection,
  ConfigAggregator,
  OrgConfigProperties,
  StateAggregator,
} from "@salesforce/core";
import { encode } from "@toon-format/toon";
import { getUserIdByUsername } from "../salesforce/users.js";
import {
  getOrCreateDebugLevelId,
  type DebugLevelInput,
} from "../salesforce/debugLevels.js";
import { ensureTraceFlag } from "../salesforce/traceFlags.js";
import { connect } from "../salesforce/connection.js";

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

export const executeAnonymousToolConfig = {
  title: "Execute Anonymous Apex",
  description:
    "Execute a snippet of anonymous Apex against an authenticated Salesforce org (via SF CLI). Saves the resulting debug log to a local file and returns a summary with the file path. Use the file path with get_apex_log_summary, analyze_apex_log_performance, or find_performance_bottlenecks for deeper analysis.",
  inputSchema: executeAnonymousInputSchema,
  annotations: {
    title: "Execute Anonymous Apex",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

async function getProjectPath(server: McpServer): Promise<string | undefined> {
  try {
    const { roots } = await server.server.listRoots();
    const rootUri = roots[0]?.uri;
    return rootUri ? new URL(rootUri).pathname : undefined;
  } catch {
    return undefined;
  }
}

async function resolveConfigProperty(
  projectPath: string | undefined,
  property: OrgConfigProperties,
): Promise<string | undefined> {
  const aggregator = await ConfigAggregator.create({ projectPath });
  return aggregator.getPropertyValue<string>(property) ?? undefined;
}

async function resolveToUsername(aliasOrUsername: string): Promise<string> {
  const stateAggregator = await StateAggregator.getInstance();
  return stateAggregator.aliases.resolveUsername(aliasOrUsername);
}

async function getAliasForUsername(
  username: string,
): Promise<string | undefined> {
  const stateAggregator = await StateAggregator.getInstance();
  return stateAggregator.aliases.get(username) ?? undefined;
}

async function validateOrgAllowlist(
  allowedOrgs: string[],
  username: string,
  targetOrg: string | undefined,
  projectPath: string | undefined,
): Promise<void> {
  if (allowedOrgs.length === 0) {
    throw new Error(
      "execute_anonymous is disabled. Configure --allowed-orgs to enable it.",
    );
  }

  if (allowedOrgs.includes("ALLOW_ALL_ORGS")) {
    return;
  }

  const resolvedAllowed: string[] = [];
  for (const entry of allowedOrgs) {
    if (entry === "DEFAULT_TARGET_ORG") {
      const resolved = await resolveConfigProperty(
        projectPath,
        OrgConfigProperties.TARGET_ORG,
      );
      if (resolved) {
        resolvedAllowed.push(await resolveToUsername(resolved));
      }
    } else if (entry === "DEFAULT_TARGET_DEV_HUB") {
      const resolved = await resolveConfigProperty(
        projectPath,
        OrgConfigProperties.TARGET_DEV_HUB,
      );
      if (resolved) {
        resolvedAllowed.push(await resolveToUsername(resolved));
      }
    } else {
      resolvedAllowed.push(await resolveToUsername(entry));
    }
  }

  const allowed = resolvedAllowed.map((org) => org.toLowerCase());
  const isAllowed =
    allowed.includes(username.toLowerCase()) ||
    (targetOrg !== undefined && allowed.includes(targetOrg.toLowerCase()));

  if (!isAllowed) {
    throw new Error(
      `Org "${targetOrg ?? username}" is not in the allowed orgs list. Allowed orgs: ${allowedOrgs.join(", ")}`,
    );
  }
}

export async function executeAnonymous(
  server: McpServer,
  args: ExecuteAnonymousArgs,
  allowedOrgs: string[] = [],
) {
  const { apex, targetOrg, debugLevel } = args;
  const projectPath = await getProjectPath(server);

  const connection = await connect(projectPath, targetOrg);

  const username = connection.getUsername();
  if (!username) {
    throw new Error("Could not determine username from connection");
  }

  await validateOrgAllowlist(allowedOrgs, username, targetOrg, projectPath);

  const alias = await getAliasForUsername(username);
  const orgLabel = alias ? `${username} (${alias})` : username;

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
  await fs.mkdir(outputDir, { recursive: true });

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
          success: apexResult.success,
          ...(apexResult.exceptionMessage && {
            exceptionMessage: apexResult.exceptionMessage,
          }),
          durationMs: logRecord.DurationMilliseconds,
          tip: "Add .apex-log-mcp/ to your .gitignore to avoid committing debug logs.",
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
