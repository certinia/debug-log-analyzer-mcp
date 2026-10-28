/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// The entry point of a lazy chunk, so the guard travels with it.
import "../salesforce/logging.js";
import { listApexLogs, readCursor } from "../salesforce/apexLogs.js";
import type { OpenOrg } from "../salesforce/orgAccess.js";
import { DEFAULT_LIMIT, type ListOrgLogsArgs } from "./orgLogsDefinition.js";
import { toonResult } from "./responseShaping.js";

export async function listOrgLogs(
  args: ListOrgLogsArgs,
  open: OpenOrg,
) {
  // Every other argument is a filter, so a filter added to the schema reaches the query.
  const { targetOrg, sortBy = "startTime", limit, cursor, ...filters } = args;

  const access = await open({
    action: "list debug logs",
    targetOrg,
    // A cursor from another list is refused before the org is called.
    prepare: async () =>
      cursor === undefined ? undefined : readCursor(cursor, sortBy, filters),
    write: false,
  });
  if (!access.granted) {
    return access.result;
  }

  const page = await listApexLogs(access.connection, {
    filters,
    sortBy,
    limit: limit ?? DEFAULT_LIMIT,
    after: access.value,
  });

  return toonResult({
    org: access.orgLabel,
    // Beside the rows, so an empty table reads as nothing matched, not as an answer missing.
    sortBy,
    matchedCount: page.matchedCount,
    logs: page.rows,
    ...(page.nextCursor && { nextCursor: page.nextCursor }),
  });
}
