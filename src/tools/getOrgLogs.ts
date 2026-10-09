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
  toLongId,
} from "../salesforce/apexLogs.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { toolError } from "../policy/orgExecutionPolicy.js";
import { openLogStore, saveStoredLog, type StoredLog } from "./logStore.js";
import { omitEmpty } from "./responseShaping.js";
import type { GetOrgLogsArgs } from "./orgLogsDefinition.js";

// Few enough that a large page does not trip the org's concurrent request limit.
const PARALLEL_DOWNLOADS = 4;

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
  // After the ids, so a failed query leaves no directory and no stderr line behind.
  const store = await openLogStore(
    args.outputDir,
    access.workspace,
    access.rootPaths,
  );

  // One failed log is a row with its cause; the rest still save.
  const results = await mapWithLimit(
    ids,
    PARALLEL_DOWNLOADS,
    async (id): Promise<Saved | Failed> => {
      try {
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
          ...(store.warning !== undefined && { warning: store.warning }),
          logs,
          ...omitEmpty({ failed }),
          outputDirCreated: store.created,
        }),
      },
    ],
  };
}

// A pool, not batches, so one large log holds up one slot rather than the rest of its batch.
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      // In range: the loop checked `next` before taking it.
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
