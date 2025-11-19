import { Connection } from "@salesforce/core";
import { getUserIdByUsername } from "../salesforce/users.js";
import { getOrCreateDebugLevelId } from "../salesforce/debugLevels.js";
import { ensureTraceFlag } from "../salesforce/traceFlags.js";

export interface ExecuteAnonymousArgs {
  apex: string;
}

export const executeAnonymousTool = {
  name: "execute_anonymous",
  description:
    "Execute a snippet of anonymous Apex and retrieve the resulting log",
  inputSchema: {
    type: "object",
    properties: {
      apex: {
        type: "string",
        description: "The anonymous Apex to be executed",
      },
    },
    required: ["apex"],
  },
};

export async function executeAnonymous(
  connection: Connection,
  args: ExecuteAnonymousArgs
) {
  await validateTraceFlag(connection);

  const { apex } = args;
  const apexResult = await connection.tooling.executeAnonymous(apex);

  if (!apexResult || !apexResult.compiled) {
    throw new Error(
      `Apex could not be compiled at line ${apexResult.line}, column ${apexResult.column}: ${apexResult.compileProblem}`
    );
  }

  // Get the user ID from the connection
  const username = process.env.ORG_USERNAME;
  if (!username) {
    throw new Error("ORG_USERNAME environment variable is not set");
  }
  const userId = await getUserIdByUsername(connection, username);

  const logResult = await connection.query(
    `SELECT Id FROM ApexLog
     WHERE LogUserId = '${userId}'
     ORDER BY StartTime DESC
     LIMIT 1`
  );

  if (!logResult || !logResult.records || logResult.records.length <= 0) {
    throw new Error(`Could not retrieve log from anonymous execution.`);
  }

  const logId = logResult.records[0].Id;
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

async function validateTraceFlag(connection: Connection) {
  const username = process.env.ORG_USERNAME;

  if (!username) {
    throw new Error(
      "Please set a valid ORG_USERNAME environment variable in your .env file"
    );
  }

  const userId = await getUserIdByUsername(connection, username);
  const debugLevelId = await getOrCreateDebugLevelId(connection);

  await ensureTraceFlag(connection, userId, debugLevelId);
}
