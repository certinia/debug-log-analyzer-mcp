import { Connection } from "@salesforce/core";

const TRACE_FLAG_SOBJECT = "TraceFlag";
const USER_DEBUG = "USER_DEBUG";

type TraceFlag = {
  Id: string;
  TracedEntityId: string;
  DebugLevelId: string;
  StartDate: string;
  ExpirationDate: string;
};

export async function ensureTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string,
): Promise<void> {
  const existingTraceFlag = await findActiveTraceFlag(
    connection,
    tracedEntityId,
  );

  if (existingTraceFlag) {
    return;
  }

  const createResult = await createTraceFlag(
    connection,
    tracedEntityId,
    debugLevelId,
  );

  if (!createResult.success) {
    throw new Error(
      `Failed to create TraceFlag: ${JSON.stringify(createResult.errors)}`,
    );
  }
}

async function findActiveTraceFlag(
  connection: Connection,
  tracedEntityId: string,
): Promise<TraceFlag | null> {
  const now = new Date().toISOString();
  return await connection.tooling.sobject(TRACE_FLAG_SOBJECT).findOne(
    {
      TracedEntityId: tracedEntityId,
      ExpirationDate: { $gt: now },
      LogType: USER_DEBUG,
    },
    ["Id", "TracedEntityId", "DebugLevelId", "StartDate", "ExpirationDate"],
  );
}

async function createTraceFlag(
  connection: Connection,
  tracedEntityId: string,
  debugLevelId: string,
): Promise<any> {
  return await connection.tooling.sobject(TRACE_FLAG_SOBJECT).create({
    TracedEntityId: tracedEntityId,
    DebugLevelId: debugLevelId,
    StartDate: new Date().toISOString(),
    ExpirationDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    LogType: USER_DEBUG,
  });
}
