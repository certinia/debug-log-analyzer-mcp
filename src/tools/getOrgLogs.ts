/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { encode } from "@toon-format/toon";
import {
  downloadApexLog,
  latestApexLogIds,
  mapWithLimit,
  PARALLEL_REQUESTS,
  toLongId,
} from "../salesforce/apexLogs.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { toolError } from "../policy/orgExecutionPolicy.js";
import { openLogStore, saveStoredLog, type StoredLog } from "./logStore.js";
import { progressReporter } from "./progress.js";
import { omitEmpty } from "./responseShaping.js";
import type { GetOrgLogsArgs } from "./orgLogsDefinition.js";

type Saved = { id: string } & StoredLog;
type Failed = { id: string; error: string };

export async function getOrgLogs(
  server: McpServer,
  args: GetOrgLogsArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  if (args.ids !== undefined && args.latest !== undefined) {
    return toolError("Give ids or latest, not both.");
  }

  const access = await openOrg(
    server,
    ctx,
    {
      tool: "apexlog_get_org_logs",
      action: "download debug logs",
      targetOrg: args.targetOrg,
      write: false,
    },
    policy,
  );
  if (!access.granted) {
    return access.result;
  }
  const { connection } = access;

  // Once each, or the pool downloads one log into one file several times at once.
  const ids = [
    ...new Set(
      (
        args.ids ?? (await latestApexLogIds(connection, args.latest ?? 1))
      ).map(toLongId),
    ),
  ];
  // After the ids, so a failed query leaves no directory and no stderr line behind; none at all for no logs.
  const store = ids.length
    ? await openLogStore(args.outputDir, access.workspace, access.rootPaths)
    : undefined;

  // Up to 25 logs of up to 20 MB each, so a caller can follow it and stop it.
  const { signal } = ctx.mcpReq;
  const report = progressReporter(ctx, ids.length);
  let done = 0;
  // One failed log is a row with its cause; the rest still save.
  const results = !store
    ? []
    : await mapWithLimit(
        ids,
        PARALLEL_REQUESTS,
        async (id): Promise<Saved | Failed> => {
          try {
            // The SDK sends no result once cancelled, so this only stops the work.
            signal.throwIfAborted();
            return {
              id,
              ...(await saveStoredLog(store.dir, id, () =>
                downloadApexLog(connection, id),
              )),
            };
          } catch (error) {
            return {
              id,
              error: error instanceof Error ? error.message : String(error),
            };
          } finally {
            done++;
            // Not awaited, so a slow client does not hold the slot; it catches its own failure.
            void report(`${done} of ${ids.length} logs`);
          }
        },
      );
  const logs = results.filter((r): r is Saved => !("error" in r));
  const failed = results.filter((r): r is Failed => "error" in r);

  return {
    content: [
      {
        type: "text" as const,
        text: encode({
          org: access.orgLabel,
          ...(store?.warning !== undefined && { warning: store.warning }),
          logs,
          ...omitEmpty({ failed }),
          outputDirCreated: store?.created ?? false,
        }),
      },
    ],
  };
}
