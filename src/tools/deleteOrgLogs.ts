/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  deleteApexLogs,
  describeFilters,
  filterCondition,
  findApexLogs,
  type FoundApexLogs,
  type LogSelection,
} from "../salesforce/apexLogs.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { CLOCK_SKEW_MS } from "../salesforce/soql.js";
import { toolError, type Confirmable } from "../policy/orgExecutionPolicy.js";
import { deleteReport, givenIds, shownId } from "./deleteReport.js";
import { progressReporter } from "./progress.js";
import { omitEmpty, toonResult } from "./responseShaping.js";
import type { DeleteOrgLogsArgs } from "./orgLogsDefinition.js";

// Enough ids to recognise the set by, few enough to read.
const SHOWN_IDS = 5;
const SKEW_MINUTES = CLOCK_SKEW_MS / 60_000;

/**
 * Delete stored logs by id, or every log the list tool's filters match, oldest
 * first, up to `MAX_LOGS_PER_DELETE` a call.
 */
export async function deleteOrgLogs(
  server: McpServer,
  args: DeleteOrgLogsArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  const { targetOrg, ids, ...filters } = args;
  const condition = filterCondition(filters);
  const filtered = condition !== "";
  if (ids !== undefined && filtered) {
    return toolError("Give ids or filters, not both.");
  }
  // Every log goes only when asked for by a filter, never by leaving them all out.
  if (ids === undefined && !filtered) {
    return toolError(
      `Give ids or at least one filter. To delete every log, pass startTimeTo set to now; on a production org, at least ${SKEW_MINUTES} minutes ago.`,
    );
  }
  const given = givenIds(ids ?? []);
  const selection: LogSelection = ids ? { ids: [...given.keys()] } : { filters };

  const access = await openOrg(
    server,
    ctx,
    {
      tool: "apexlog_delete_org_logs",
      action: "delete debug logs",
      targetOrg,
      write: async ({ connection }) => {
        const found = await findApexLogs(connection, selection);
        return {
          value: found,
          confirm: found.logs.length
            ? deleteConfirmable(selection, condition, found, given)
            : null,
        };
      },
    },
    policy,
  );
  if (!access.granted) {
    return access.result;
  }

  const { logs, matchedCount } = access.value;
  const logIds = logs.map((log) => log.id);
  const report = progressReporter(ctx, logs.length);
  let done = 0;
  const results = await deleteApexLogs(
    access.connection,
    logIds,
    {
      signal: ctx.mcpReq.signal,
      onBatchDone: (count) => {
        done += count;
        void report(`${done} of ${logs.length} logs`, count);
      },
    },
  );
  // Every id when sent by id, at most 200; a filter's caller lists the same filters again.
  const outcome = deleteReport(given, logIds, results, ids ? Infinity : SHOWN_IDS);
  const deleted = logs.filter((log) => outcome.deleted.has(log.id));

  return toonResult({
    org: access.orgLabel,
    deletedCount: deleted.length,
    deletedBytes: totalBytes(deleted),
    // The matches past this call's cap, and the failures, since they still hold storage.
    remainingCount: matchedCount - logs.length + outcome.failedCount,
    notFoundCount: outcome.notFoundCount,
    ...omitEmpty({ notFoundIds: outcome.notFoundIds, failed: outcome.failed }),
  });
}

/**
 * Bound to what was asked: the ids, or the filters. On production a filter
 * needs `startTimeTo` at least `CLOCK_SKEW_MS` ago, so no log filed meanwhile
 * joins, even where the org's clock runs behind this machine's.
 */
function deleteConfirmable(
  selection: LogSelection,
  condition: string,
  { logs, matchedCount }: FoundApexLogs,
  given: Map<string, string>,
): Confirmable {
  const count =
    matchedCount > logs.length
      ? `${logs.length} of the ${matchedCount} debug logs that match, the oldest first; call again for the rest`
      : debugLogs(logs.length);
  const confirmed = (effect: string, asked: string) => ({
    effect,
    detail: `${count}, ${totalBytes(logs)} bytes. ${asked}.\n\nA deleted log cannot be restored.`,
    title: `Delete ${debugLogs(logs.length)}`,
  });
  if ("ids" in selection) {
    return confirmed(
      [...selection.ids].sort().join(","),
      `By id: ${firstOf(logs.map((log) => shownId(given, log.id)))}`,
    );
  }
  const { startTimeTo } = selection.filters;
  return {
    ...confirmed(condition, `Every log with ${describeFilters(selection.filters)}`),
    // Only read where the call would ask, so a sandbox needs no startTimeTo.
    ...(!(startTimeTo && Date.parse(startTimeTo) <= Date.now() - CLOCK_SKEW_MS) && {
      unshowable: `On a production org, a delete by filter needs startTimeTo at least ${SKEW_MINUTES} minutes ago, so no log filed while you confirm can join what you were shown. Pass startTimeTo, or delete by ids.`,
    }),
  };
}

function debugLogs(count: number): string {
  return `${count} debug log${count === 1 ? "" : "s"}`;
}

function firstOf(ids: string[]): string {
  const more = ids.length > SHOWN_IDS ? ` and ${ids.length - SHOWN_IDS} more` : "";
  return ids.slice(0, SHOWN_IDS).join(", ") + more;
}

function totalBytes(logs: { fileSizeBytes: number }[]): number {
  return logs.reduce((total, log) => total + log.fileSizeBytes, 0);
}
