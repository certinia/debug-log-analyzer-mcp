/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { encode } from "@toon-format/toon";
import {
  deleteApexLogs,
  describeFilters,
  type DeleteResult,
  filterCondition,
  findApexLogs,
  type FoundApexLogs,
  type LogSelection,
} from "../salesforce/apexLogs.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { CLOCK_SKEW_MS, toLongId } from "../salesforce/soql.js";
import { toolError, type Confirmable } from "../policy/orgExecutionPolicy.js";
import { progressReporter } from "./progress.js";
import { omitEmpty } from "./responseShaping.js";
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
  // Each id as the API writes it, mapped back to the form the caller sent.
  const given = new Map(ids?.map((id) => [toLongId(id), id]));
  const shownId = (id: string): string => given.get(id) ?? id;
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
            ? deleteConfirmable(selection, condition, found, shownId)
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
  const report = progressReporter(ctx, logs.length);
  let done = 0;
  const results = await deleteApexLogs(
    access.connection,
    logs.map((log) => log.id),
    {
      signal: ctx.mcpReq.signal,
      onBatchDone: (count) => {
        done += count;
        void report(`${done} of ${logs.length} logs`, count);
      },
    },
  );
  const deleted = logs.filter((_, index) => {
    // In range: one result per log, in the order sent.
    const { error, alreadyGone } = results[index]!;
    return !error && !alreadyGone;
  });
  // Found, then deleted by another call or expired before this one reached it.
  const gone = results.filter((result) => result.alreadyGone).map(({ id }) => shownId(id));
  const stored = new Set(logs.map((log) => log.id));
  // Not a failure: a retry after a lost response finds the logs it deleted gone.
  const notFound = [...given]
    .filter(([id]) => !stored.has(id))
    .map(([, id]) => id)
    .concat(gone);
  // Every id when sent by id, at most 200; a filter's caller lists the same filters again.
  const idLimit = ids ? Infinity : SHOWN_IDS;

  return {
    content: [
      {
        type: "text" as const,
        text: encode({
          org: access.orgLabel,
          deletedCount: deleted.length,
          deletedBytes: totalBytes(deleted),
          // Every match not deleted or gone, failures included, since they still hold storage.
          remainingCount: matchedCount - deleted.length - gone.length,
          notFoundCount: notFound.length,
          ...omitEmpty({
            notFoundIds: notFound.slice(0, idLimit),
            failed: groupFailures(results, shownId, idLimit),
          }),
        }),
      },
    ],
  };
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
  shownId: (id: string) => string,
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
      `By id: ${firstOf(logs.map((log) => shownId(log.id)))}`,
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

type FailureRow = { error: string; logCount: number; ids: string[] };

// One row per cause, since one cause, such as a missing permission, can fail every log.
function groupFailures(
  results: DeleteResult[],
  shownId: (id: string) => string,
  idLimit: number,
): FailureRow[] {
  const byError = new Map<string, FailureRow>();
  for (const { id, error } of results) {
    if (error === undefined) {
      continue;
    }
    const row = byError.get(error) ?? { error, logCount: 0, ids: [] };
    row.logCount += 1;
    if (row.ids.length < idLimit) {
      row.ids.push(shownId(id));
    }
    byError.set(error, row);
  }
  return [...byError.values()];
}

function totalBytes(logs: { fileSizeBytes: number }[]): number {
  return logs.reduce((total, log) => total + log.fileSizeBytes, 0);
}
