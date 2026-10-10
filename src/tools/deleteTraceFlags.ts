/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { destroyTraceFlags, findTraceFlags } from "../salesforce/traceFlags.js";
import { deleteReport, givenIds } from "./deleteReport.js";
import { omitEmpty, toonResult } from "./responseShaping.js";
import type { DeleteTraceFlagsArgs } from "./traceFlagsDefinition.js";

/** Delete trace flags by id, failures grouped by cause. */
export async function deleteTraceFlags(
  server: McpServer,
  args: DeleteTraceFlagsArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  const given = givenIds(args.ids);
  const ids = [...given.keys()];

  const access = await openOrg(
    server,
    ctx,
    {
      tool: "apexlog_delete_trace_flags",
      action: "delete trace flags",
      targetOrg: args.targetOrg,
      write: async ({ connection }) => {
        const flags = await findTraceFlags(connection, ids);
        return {
          value: flags,
          confirm: flags.length
            ? {
                effect: [...ids].sort().join(","),
                detail: `Stop logging: ${flags.map((flag) => `${flag.tracedEntity} (${flag.logType}, ${flag.id})`).join(", ")}.`,
                title: `Delete ${flags.length} trace flag${flags.length === 1 ? "" : "s"}`,
              }
            : null,
        };
      },
    },
    policy,
  );
  if (!access.granted) {
    return access.result;
  }

  const foundIds = access.value.map((flag) => flag.id);
  const results = await destroyTraceFlags(access.connection, foundIds, ctx.mcpReq.signal);
  // At most 200 ids, so every one is listed.
  const outcome = deleteReport(given, foundIds, results, Infinity);

  return toonResult({
    org: access.orgLabel,
    deletedCount: outcome.deleted.size,
    notFoundCount: outcome.notFoundCount,
    ...omitEmpty({ notFoundIds: outcome.notFoundIds, failed: outcome.failed }),
  });
}
