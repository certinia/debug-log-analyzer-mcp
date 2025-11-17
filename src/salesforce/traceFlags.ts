import { Connection } from "jsforce";

const TRACE_FLAG_SOBJECT = "TraceFlag";

export async function ensureTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string
): Promise<void> {
  try {
    await getActiveTraceFlag(connection, tracedEntityId);
    return;
  } catch {
    // No active trace flag found, create one
  }

  const createResult = await createTraceFlag(
    connection,
    tracedEntityId,
    debugLevelId
  );

  if (!createResult.success) {
    throw new Error(
      `Failed to create TraceFlag: ${JSON.stringify(createResult.errors)}`
    );
  }
}

async function getActiveTraceFlag(
  connection: Connection,
  tracedEntityId: string
): Promise<any> {
  const now = new Date().toISOString();
  const result = await connection.tooling.query(
    `SELECT Id, TracedEntityId, DebugLevelId, StartDate, ExpirationDate
     FROM ${TRACE_FLAG_SOBJECT}
     WHERE TracedEntityId = '${tracedEntityId}'
     AND ExpirationDate > ${now}
     AND LogType = 'USER_DEBUG'
     LIMIT 1`
  );

  if (result.records.length === 0) {
    throw new Error("No active TraceFlag found!");
  }

  if (!result.records[0]) {
    throw new Error("Found an empty TraceFlag!");
  }

  return result.records[0];
}

async function createTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string
): Promise<any> {
  return await connection.tooling.sobject(TRACE_FLAG_SOBJECT).create({
    TracedEntityId: tracedEntityId,
    DebugLevelId: debugLevelId,
    StartDate: new Date().toISOString(),
    ExpirationDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    LogType: "USER_DEBUG",
  });
}
