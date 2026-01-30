import { Connection } from "@salesforce/core";
import { getUserIdByUsername } from "../salesforce/users.js";
import { getOrCreateDebugLevelId } from "../salesforce/debugLevels.js";
import { ensureTraceFlag } from "../salesforce/traceFlags.js";

export interface ExecuteAnonymousArgs {
  apex: string;
}

type ApexLogRecord = {
  Id: string;
};

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
  args: ExecuteAnonymousArgs,
) {
  const { apex } = args;

  const username = connection.getUsername();
  if (!username) {
    throw new Error("Could not determine username from connection");
  }

  const userId = await getUserIdByUsername(connection, username);
  await validateTraceFlag(connection, userId);

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

async function validateTraceFlag(connection: Connection, userId: string) {
  const debugLevelId = await getOrCreateDebugLevelId(connection);
  await ensureTraceFlag(connection, userId, debugLevelId);
}
