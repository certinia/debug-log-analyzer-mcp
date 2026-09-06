import type { Connection } from "@salesforce/core";
import { toDateTimeLiteral } from "./soql.js";

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
    if (existingTraceFlag.DebugLevelId !== debugLevelId) {
      await updateTraceFlag(connection, existingTraceFlag.Id, debugLevelId);
    }
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
  return await connection.tooling.sobject(TRACE_FLAG_SOBJECT).findOne(
    {
      TracedEntityId: tracedEntityId,
      ExpirationDate: { $gt: toDateTimeLiteral(new Date()) },
      LogType: USER_DEBUG,
    },
    ["Id", "TracedEntityId", "DebugLevelId", "StartDate", "ExpirationDate"],
  );
}

async function updateTraceFlag(
  connection: Connection,
  traceFlagId: string,
  debugLevelId: string,
): Promise<void> {
  const result = await connection.tooling
    .sobject(TRACE_FLAG_SOBJECT)
    .update({ Id: traceFlagId, DebugLevelId: debugLevelId });

  if (!result.success) {
    throw new Error(
      `Failed to update TraceFlag: ${JSON.stringify(result.errors)}`,
    );
  }
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
