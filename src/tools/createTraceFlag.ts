/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  DEFAULT_TRACE_CONFIG,
  ensureLevelsDebugLevel,
  levelsClause,
  requestedLevels,
} from "../salesforce/debugLevels.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { isoSeconds } from "../salesforce/soql.js";
import {
  createTraceFlag as writeTraceFlag,
  findOverlappingTraceFlag,
  logTypeFor,
  resolveTracedEntity,
  traceFlagWindow,
  type TraceFlagRow,
} from "../salesforce/traceFlags.js";
import { toolError } from "../policy/orgExecutionPolicy.js";
import { toonResult } from "./responseShaping.js";
import type { CreateTraceFlagArgs } from "./traceFlagsDefinition.js";

const DEFAULT_DURATION_MINUTES = 30;

/**
 * Trace a user, class or trigger for a while. Never changes a flag already on
 * it (#207): that one is returned, to delete first.
 */
export async function createTraceFlag(
  server: McpServer,
  args: CreateTraceFlagArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  const minutes = args.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const durationMs = minutes * 60_000;
  const levels = args.debugLevel
    ? requestedLevels(args.debugLevel)
    : DEFAULT_TRACE_CONFIG;
  const clause = levelsClause(levels);

  const access = await openOrg(
    server,
    ctx,
    {
      tool: "apexlog_create_trace_flag",
      action: "create a trace flag",
      targetOrg: args.targetOrg,
      write: async ({ connection }) => {
        const entity = await resolveTracedEntity(connection, args.tracedEntity);
        const logType = logTypeFor(entity);
        // Salesforce refuses an overlapping flag of the same type anyway; found first, the refusal can name it.
        const { live: existing, notBefore } = await findOverlappingTraceFlag(
          connection,
          entity,
          logType,
          durationMs,
        );
        return {
          value: { entity, logType, existing, notBefore },
          confirm: existing
            ? null
            : {
                effect: `${entity.id}\0${logType}\0${clause}\0${minutes}`,
                detail: `Trace ${entity.name} (${entity.type}) as ${logType} for ${minutes} minutes, at ${clause}. ${
                  logType === "USER_DEBUG"
                    ? "Every transaction the user runs while the flag lives is stored as a debug log, which can fill the org's log storage."
                    : "It sets the levels of this code's work in the logs a user's flag stores, and stores no log itself."
                }`,
                title: `Trace ${entity.name} for ${minutes} minutes`,
              },
        };
      },
    },
    policy,
  );
  if (!access.granted) {
    return access.result;
  }

  const { entity, logType, existing, notBefore } = access.value;
  if (existing) {
    return toolError(
      `${entity.name} already has a ${logType} trace flag, ${existing.id}, at ${existing.levels}, from ${existing.startTime} until ${existing.expirationTime}. A flag is never changed here: delete it with apexlog_delete_trace_flags, then create.`,
    );
  }

  // From now, not from the check, since a confirmation can take minutes.
  const window = traceFlagWindow(durationMs, notBefore);
  let flag: TraceFlagRow;
  try {
    const debugLevel = await ensureLevelsDebugLevel(access.connection, levels);
    flag = {
      id: await writeTraceFlag(
        access.connection,
        entity.id,
        debugLevel.id,
        window,
        logType,
      ),
      tracedEntity: entity.name,
      entityType: entity.type,
      logType,
      debugLevelName: debugLevel.name,
      levels: clause,
      startTime: isoSeconds(window.start.toISOString()),
      expirationTime: isoSeconds(window.end.toISOString()),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const next = /storage/i.test(message)
      ? // When the org's log storage is full, no flag can be written until logs are deleted.
        " Free the org's debug log storage with apexlog_delete_org_logs, then try again."
      : /already being traced/i.test(message)
        ? // A flag set while the call waited, such as for a confirmation, was not there to name.
          " Find the flag in the way with apexlog_list_trace_flags, delete it with apexlog_delete_trace_flags, then create."
        : "";
    return toolError(message + next);
  }

  return toonResult({ org: access.orgLabel, ...flag });
}
