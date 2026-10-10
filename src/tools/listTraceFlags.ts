/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import {
  listTraceFlags as readTraceFlags,
  resolveTracedEntity,
} from "../salesforce/traceFlags.js";
import { toonResult } from "./responseShaping.js";
import type { ListTraceFlagsArgs } from "./traceFlagsDefinition.js";

/** The trace flags not yet expired, on one entity or on every one. */
export async function listTraceFlags(
  server: McpServer,
  args: ListTraceFlagsArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  const access = await openOrg(
    server,
    ctx,
    {
      tool: "apexlog_list_trace_flags",
      action: "list trace flags",
      targetOrg: args.targetOrg,
      write: false,
    },
    policy,
  );
  if (!access.granted) {
    return access.result;
  }

  const entity =
    args.tracedEntity === undefined
      ? undefined
      : await resolveTracedEntity(access.connection, args.tracedEntity);
  const { flags, matchedCount } = await readTraceFlags(access.connection, entity);

  return toonResult({
    org: access.orgLabel,
    // Beside the rows, so an empty table reads as no flag on this entity, not on any.
    ...(entity && { tracedEntity: entity.name }),
    // Beside a capped table, so a cut list reads as one.
    matchedCount,
    flags,
  });
}
