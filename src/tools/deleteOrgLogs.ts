/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { encode } from "@toon-format/toon";
import {
  deleteApexLogs,
  filterCondition,
  findApexLogs,
  toLongId,
  type FoundApexLogs,
  type LogSelection,
} from "../salesforce/apexLogs.js";
import { openOrg, type OrgAccessPolicy } from "../salesforce/orgAccess.js";
import { toolError, type Confirmable } from "../policy/orgExecutionPolicy.js";
import { omitEmpty } from "./responseShaping.js";
import type { DeleteOrgLogsArgs } from "./orgLogsDefinition.js";

/**
 * Delete stored logs by id, or every log the list tool's filters match, up to
 * `MAX_LOGS_PER_DELETE` a call, oldest first.
 */
export async function deleteOrgLogs(
  server: McpServer,
  args: DeleteOrgLogsArgs,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) {
  const { targetOrg, ids, ...filters } = args;
  // An empty string or a zero narrows nothing, so it must not pass for a filter.
  const condition = filterCondition(filters);
  const filtered = condition !== "";
  if (ids !== undefined && filtered) {
    return toolError("Give ids or filters, not both.");
  }
  // Every log goes only when asked for by a filter, never by leaving them all out.
  if (ids === undefined && !filtered) {
    return toolError(
      "Give ids or at least one filter. To delete every log, pass startTimeTo set to now.",
    );
  }
  // Each id as the API writes it, mapped back to the form the caller sent.
  const given = new Map(ids?.map((id) => [toLongId(id), id]));
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
            ? deleteConfirmable(selection, condition, found)
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
  const results = await deleteApexLogs(
    access.connection,
    logs.map((log) => log.id),
    ctx.mcpReq.signal,
  );
  const failures = results.filter((result) => result.error !== undefined);
  const failedIds = new Set(failures.map((result) => result.id));
  const stored = new Set(logs.map((log) => log.id));
  const failed = failures
    .map(({ id, error }) => ({ id: given.get(id) ?? id, error }))
    .concat(
      // An id that names no stored log: already deleted, or never in this org.
      [...given]
        .filter(([id]) => !stored.has(id))
        .map(([, id]) => ({ id, error: "no stored log has this id" })),
    );
  const deleted = logs.filter((log) => !failedIds.has(log.id));

  return {
    content: [
      {
        type: "text" as const,
        text: encode({
          org: access.orgLabel,
          deletedCount: deleted.length,
          deletedBytes: totalBytes(deleted),
          // Every match not deleted, failures included, since they still hold storage.
          remainingCount: matchedCount - deleted.length,
          ...omitEmpty({ failed }),
        }),
      },
    ],
  };
}

/**
 * Bound to what was asked: the ids, or the filters. Logs that expire while the
 * person reads only shrink that set, and on production a filter must carry
 * `startTimeTo` no later than now, so no log filed meanwhile can join it.
 */
function deleteConfirmable(
  selection: LogSelection,
  condition: string,
  { logs, matchedCount }: FoundApexLogs,
): Confirmable {
  const startTimeTo = "filters" in selection && selection.filters.startTimeTo;
  const count =
    matchedCount > logs.length
      ? `${logs.length} of the ${matchedCount} debug logs that match, the oldest first; call again for the rest`
      : `${logs.length} debug logs`;
  const asked =
    "ids" in selection
      ? `By id: ${logs.map((log) => log.id).join(", ")}`
      : `Every log where ${condition}`;
  return {
    effect:
      "ids" in selection ? [...selection.ids].sort().join(",") : condition,
    detail: `${count}, ${totalBytes(logs)} bytes. ${asked}.\n\nA deleted log cannot be restored.`,
    title: `Delete ${logs.length} debug logs`,
    // Only read where the call would ask, so a sandbox needs no startTimeTo.
    ...("filters" in selection &&
      !(startTimeTo && Date.parse(startTimeTo) <= Date.now()) && {
        unshowable:
          "On a production org, a delete by filter needs startTimeTo, no later than now, so no log filed while you confirm can join what you were shown. Pass startTimeTo, or delete by ids.",
      }),
  };
}

function totalBytes(logs: { fileSizeBytes: number }[]): number {
  return logs.reduce((total, log) => total + log.fileSizeBytes, 0);
}
