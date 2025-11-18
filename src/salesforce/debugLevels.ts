import { Connection } from "@salesforce/core";

const DEBUG_LEVEL_SOBJECT = "DebugLevel";
const DEVELOPER_NAME_FIELD = "DeveloperName";
const MCP_DEBUG_LEVEL_NAME = "LANA_MCP_Debug_Level";

export async function getOrCreateDebugLevelId(
  connection: Connection
): Promise<string> {
  const existingDebugLevelId = await findDebugLevelId(connection);

  if (existingDebugLevelId) {
    return existingDebugLevelId;
  }

  return await createDebugLevel(connection);
}

async function findDebugLevelId(connection: Connection): Promise<string | null> {
  const result = await connection.tooling.query(
    `SELECT Id, ${DEVELOPER_NAME_FIELD}, ApexCode, ApexProfiling, Database
     FROM ${DEBUG_LEVEL_SOBJECT}
     WHERE ApexCode = 'FINEST'
     AND ApexProfiling = 'FINEST'
     AND Database = 'FINEST'
     LIMIT 1`
  );

  if (result.records.length === 0) {
    return null;
  }

  const debugLevelId = result.records[0].Id;
  return debugLevelId || null;
}

async function createDebugLevel(
  connection: Connection
): Promise<string> {
  const result = await connection.tooling.sobject(DEBUG_LEVEL_SOBJECT).create({
    DeveloperName: MCP_DEBUG_LEVEL_NAME,
    MasterLabel: MCP_DEBUG_LEVEL_NAME,
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
