import { Connection } from "@salesforce/core";

const TRACE_FLAG_SOBJECT = "TraceFlag";
const USER_DEBUG = "USER_DEBUG";

export async function ensureTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string
): Promise<void> {
  const existingTraceFlag = await findActiveTraceFlag(connection, tracedEntityId);

  if (existingTraceFlag) {
    return;
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

async function findActiveTraceFlag(
  connection: Connection,
  tracedEntityId: string
): Promise<any | null> {
  const now = new Date().toISOString();
  const result = await connection.tooling.query(
    `SELECT Id, TracedEntityId, DebugLevelId, StartDate, ExpirationDate
     FROM ${TRACE_FLAG_SOBJECT}
     WHERE TracedEntityId = '${tracedEntityId}'
     AND ExpirationDate > ${now}
     AND LogType = '${USER_DEBUG}'
     LIMIT 1`
  );

  return result.records.length > 0 ? result.records[0] : null;
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
    LogType: USER_DEBUG,
  });
}
