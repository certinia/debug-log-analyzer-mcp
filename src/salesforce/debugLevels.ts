import { Connection } from "jsforce";

const DEBUG_LEVEL_SOBJECT = "DebugLevel";
const DEVELOPER_NAME_FIELD = "DeveloperName";

export async function getOrCreateDebugLevelId(
  connection: Connection
): Promise<string> {
  let debugLevelId: string;

  try {
    debugLevelId = await getDebugLevelId(connection);
  } catch {
    debugLevelId = await createDebugLevel(connection, "LANA_Debug_Level");
  }

  return debugLevelId;
}

async function getDebugLevelId(
  connection: Connection,
  developerName?: string
): Promise<string> {
  // If no name provided, get the first available debug level
  const queryStr = developerName
    ? `SELECT Id, ${DEVELOPER_NAME_FIELD} FROM ${DEBUG_LEVEL_SOBJECT} WHERE ${DEVELOPER_NAME_FIELD} = '${developerName}'`
    : `SELECT Id, ${DEVELOPER_NAME_FIELD} FROM ${DEBUG_LEVEL_SOBJECT} LIMIT 1`;

  const result = await connection.tooling.query(queryStr);

  if (result.records.length === 0) {
    throw new Error(
      developerName
        ? `DebugLevel not found with name ${developerName}`
        : "No DebugLevel found in org"
    );
  }

  const debugLevelId = result.records[0].Id;
  if (!debugLevelId) {
    throw new Error("DebugLevel Id is undefined");
  }

  return debugLevelId;
}

async function createDebugLevel(
  connection: Connection,
  developerName: string = "LANA_MCP_Debug_Level"
): Promise<string> {
  const result = await connection.tooling.sobject(DEBUG_LEVEL_SOBJECT).create({
    DeveloperName: developerName,
    MasterLabel: developerName,
    ApexCode: "FINEST",
    ApexProfiling: "FINEST",
    Callout: "FINEST",
    Database: "FINEST",
    System: "DEBUG",
    Validation: "INFO",
    Visualforce: "INFO",
    Workflow: "INFO",
  });

  if (!result.success || !result.id) {
    throw new Error("Failed to create DebugLevel");
  }

  return result.id;
}
