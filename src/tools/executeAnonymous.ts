import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Connection } from "@salesforce/core";
import { getUserIdByUsername } from "../salesforce/users.js";
import {
  getOrCreateDebugLevelId,
  DebugLevelInput,
} from "../salesforce/debugLevels.js";
import { ensureTraceFlag } from "../salesforce/traceFlags.js";
import { connect } from "../salesforce/connection.js";

export interface ExecuteAnonymousArgs {
  apex: string;
  targetOrg?: string;
  debugLevel?: DebugLevelInput;
}

type ApexLogRecord = {
  Id: string;
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
];

function logLevelProperty(description: string) {
  return { type: "string", enum: LOG_LEVEL_ENUM, description };
}

export const executeAnonymousTool = {
  name: "execute_anonymous",
  description:
    "Execute a snippet of anonymous Apex against any Salesforce org and retrieve the resulting debug log",
  inputSchema: {
    type: "object",
    properties: {
      apex: {
        type: "string",
        description: "The anonymous Apex to be executed",
      },
      targetOrg: {
        type: "string",
        description:
          "Alias or username of the target Salesforce org. Uses the project default if not specified.",
      },
      debugLevel: {
        description:
          'Optional debug level configuration. Use "default" to reset all categories to defaults. Use a log level string (e.g. "FINEST") to set all categories to that level. Use an object to override specific categories. Omit entirely to keep the existing configuration.',
        oneOf: [
          {
            type: "string",
            enum: ["default", ...LOG_LEVEL_ENUM],
            description:
              'Use "default" to reset to defaults, or a log level (e.g. "FINEST") to set all categories to that level.',
          },
          {
            type: "object",
            description:
              "Override specific log categories. Only specified categories are updated; others remain unchanged.",
            properties: {
              apexCode: logLevelProperty("Apex code log level (default: FINE)"),
              apexProfiling: logLevelProperty(
                "Apex profiling log level (default: FINE)",
              ),
              callout: logLevelProperty("Callout log level (default: DEBUG)"),
              database: logLevelProperty(
                "Database log level (default: FINEST)",
              ),
              nba: logLevelProperty(
                "NBA (Next Best Action) log level (default: INFO)",
              ),
              system: logLevelProperty("System log level (default: DEBUG)"),
              validation: logLevelProperty(
                "Validation log level (default: DEBUG)",
              ),
              visualforce: logLevelProperty(
                "Visualforce log level (default: FINE)",
              ),
              wave: logLevelProperty(
                "Wave/Analytics log level (default: INFO)",
              ),
              workflow: logLevelProperty("Workflow log level (default: FINE)"),
            },
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["apex"],
  },
};

async function getProjectPath(server: Server): Promise<string | undefined> {
  try {
    const { roots } = await server.listRoots();
    const rootUri = roots[0]?.uri;
    return rootUri ? new URL(rootUri).pathname : undefined;
  } catch {
    return undefined;
  }
}

export async function executeAnonymous(
  server: Server,
  args: ExecuteAnonymousArgs,
) {
  const { apex, targetOrg, debugLevel } = args;
  const projectPath = await getProjectPath(server);

  const connection = await connect(projectPath, targetOrg);

  const username = connection.getUsername();
  if (!username) {
    throw new Error("Could not determine username from connection");
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
    .findOne({ LogUserId: userId }, ["Id"], {
      sort: { StartTime: -1 },
    })) as ApexLogRecord | null;

  if (!logRecord) {
    throw new Error(`Could not retrieve log from anonymous execution.`);
  }

  const logId = logRecord.Id;
  const logBody = await connection.request(`/sobjects/ApexLog/${logId}/Body/`);

  return {
    content: [
      {
        type: "text",
        text: logBody,
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
