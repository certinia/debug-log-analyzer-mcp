/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { encode } from "@toon-format/toon";
import { mapRequests } from "../salesforce/parallelRequests.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { toLongId } from "../salesforce/soql.js";
import { deleteTraceFlag, findTraceFlags } from "../salesforce/traceFlags.js";
import { omitEmpty } from "./responseShaping.js";
import type { DeleteTraceFlagsArgs } from "./traceFlagsDefinition.js";

/** Delete trace flags by id, each failure kept beside its id. */
export async function deleteTraceFlags(
  server: McpServer,
  args: DeleteTraceFlagsArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  // Each id as the API writes it, mapped back to the form the caller sent.
  const given = new Map(args.ids.map((id) => [toLongId(id), id]));
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

  const found = new Set(access.value.map((flag) => flag.id));
  const results = await mapRequests(
    [...found],
    async (id) => {
      // Once cancelled, no further request is sent; the flag is reported as left.
      if (ctx.mcpReq.signal.aborted) {
        return { id, error: "not deleted: the call was cancelled" };
      }
      try {
        await deleteTraceFlag(access.connection, id);
        return { id };
      } catch (error) {
        return { id, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  const failures = results.flatMap((result) =>
    "error" in result ? [{ id: given.get(result.id) ?? result.id, error: result.error }] : [],
  );
  const failed = failures.concat(
    // An id that names no flag: already deleted, or never in this org.
    [...given]
      .filter(([id]) => !found.has(id))
      .map(([, id]) => ({ id, error: "no trace flag has this id" })),
  );

  return {
    content: [
      {
        type: "text" as const,
        text: encode({
          org: access.orgLabel,
          deletedCount: results.length - failures.length,
          ...omitEmpty({ failed }),
        }),
      },
    ],
  };
}
