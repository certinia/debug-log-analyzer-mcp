/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { createHash } from "node:crypto";
import type { Connection } from "@salesforce/core";
import {
  CLOCK_SKEW_MS,
  escapeSoql,
  quote,
  toDateTimeLiteral,
} from "./soql.js";

const APEX_LOG_SOBJECT = "ApexLog";

/** What a list sorts on, newest, slowest or largest first. */
export const LOG_SORTS = [
  "startTime",
  "durationTotalMs",
  "fileSizeBytes",
] as const;
export type LogSort = (typeof LOG_SORTS)[number];

const SORT_FIELD: Record<LogSort, keyof ApexLogRecord> = {
  startTime: "StartTime",
  durationTotalMs: "DurationMilliseconds",
  fileSizeBytes: "LogLength",
};

/** Every filter is optional, and they combine with AND. */
export type LogFilters = {
  /** The running user's username. */
  user?: string;
  /** Contains, any case: "aura" finds "/aura". */
  operation?: string;
  request?: string;
  /** True for `Status = 'Success'`, false for any other status, which is the exception message. */
  succeeded?: boolean;
  startTimeFrom?: string;
  startTimeTo?: string;
  minFileSizeBytes?: number;
};

type OrgLogRow = {
  id: string;
  user: string;
  operation: string;
  request: string;
  succeeded: boolean;
  /** The org's `Status` for a failed log, or empty, as `apexlog_execute_anonymous` names it. */
  exceptionMessage: string;
  startTime: string;
  durationTotalMs: number;
  /** The size the log saves to, so it reads against `fileSizeBytes` from the other tools. */
  fileSizeBytes: number;
};

export type OrgLogPage = {
  rows: OrgLogRow[];
  /** Logs the filters match, before the cursor and the limit. */
  matchedCount: number;
  /** Absent on the last page. */
  nextCursor?: string;
};

type ApexLogRecord = {
  Id: string;
  LogUser: { Username: string } | null;
  Operation: string;
  Request: string;
  Status: string;
  StartTime: string;
  DurationMilliseconds: number;
  LogLength: number;
};

/** True for a debug log id, 15 or 18 characters. */
export function isApexLogId(id: string): boolean {
  return /^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id);
}

const ID_SUFFIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/**
 * The 18-character form of an id, which the API returns: a 15-character id
 * names the same log, so without this it would save to a second file.
 */
export function toLongId(id: string): string {
  if (id.length !== 15) {
    return id;
  }
  // Each suffix character encodes which of 5 characters are upper case.
  const suffix = [0, 5, 10]
    .map((start) =>
      [...id.slice(start, start + 5)].reduce(
        (bits, char, bit) => (/[A-Z]/.test(char) ? bits | (1 << bit) : bits),
        0,
      ),
    )
    .map((bits) => ID_SUFFIX_CHARS[bits])
    .join("");
  return id + suffix;
}

/** A SOQL `LIKE` pattern matching `value` anywhere: its own `%` and `_` match only themselves. */
function containing(value: string): string {
  return `'%${escapeSoql(value).replace(/[%_]/g, "\\$&")}%'`;
}

// The org returns `+0000`, which SOQL does not read back as a date-time literal.
function sortLiteral(sort: LogSort, value: string | number): string {
  return sort === "startTime"
    ? new Date(value).toISOString()
    : String(Number(value));
}

function whereClauses(filters: LogFilters): string[] {
  return [
    filters.user !== undefined && `LogUser.Username = ${quote(filters.user)}`,
    filters.operation !== undefined &&
      `Operation LIKE ${containing(filters.operation)}`,
    filters.request !== undefined && `Request = ${quote(filters.request)}`,
    filters.succeeded !== undefined &&
      `Status ${filters.succeeded ? "=" : "!="} 'Success'`,
    filters.startTimeFrom !== undefined &&
      `StartTime >= ${new Date(filters.startTimeFrom).toISOString()}`,
    filters.startTimeTo !== undefined &&
      `StartTime <= ${new Date(filters.startTimeTo).toISOString()}`,
    filters.minFileSizeBytes !== undefined &&
      `LogLength >= ${filters.minFileSizeBytes}`,
  ].filter((clause): clause is string => typeof clause === "string");
}

// A digest, not the list itself, because the cursor is paid for on every page.
function listKey(sort: LogSort, filters: LogFilters): string {
  return createHash("sha256")
    .update([sort, ...whereClauses(filters)].join(" AND "))
    .digest("base64url")
    .slice(0, 8);
}

/** Where a cursor resumes, and the count its first page took. */
export type ResumePoint = { value: string | number; id: string; matchedCount: number };

/**
 * Read a cursor back, refusing one this list did not give.
 *
 * A cursor says where the next page starts: after the last row's sort value,
 * with `Id` to break a tie. SOQL refuses an `OFFSET` over 2,000 on `ApexLog`,
 * and this has no such bound. It carries a digest of the sort and the filters,
 * so it cannot be spent on a different list.
 */
export function readCursor(
  text: string,
  sort: LogSort,
  filters: LogFilters,
): ResumePoint {
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new Error(
      "cursor is not one this tool returned. Leave it out to start from the first page.",
    );
  }
  const [list, value, id, matchedCount] = Array.isArray(cursor) ? cursor : [];
  // The value reaches SOQL, so it must be the sort's own type.
  const valueFits =
    sort === "startTime"
      ? typeof value === "string" && !Number.isNaN(Date.parse(value))
      : Number.isFinite(value);
  if (
    list !== listKey(sort, filters) ||
    !valueFits ||
    typeof id !== "string" ||
    !isApexLogId(id) ||
    !Number.isInteger(matchedCount)
  ) {
    throw new Error(
      "cursor belongs to a list with other filters or another sortBy. Pass the same ones, or leave cursor out to start again.",
    );
  }
  return { value, id, matchedCount };
}

function toRow(record: ApexLogRecord): OrgLogRow {
  return {
    id: record.Id,
    user: record.LogUser?.Username ?? "",
    operation: record.Operation,
    request: record.Request,
    succeeded: record.Status === "Success",
    exceptionMessage: record.Status === "Success" ? "" : record.Status,
    // ISO 8601 in UTC, as the startTime filters take it; the org sends `+0000` and milliseconds it never sets.
    startTime: new Date(record.StartTime).toISOString().replace(".000Z", "Z"),
    durationTotalMs: record.DurationMilliseconds,
    fileSizeBytes: record.LogLength,
  };
}

/**
 * One page of the org's stored logs. Filtered, sorted and cut in SOQL, so the
 * cost follows `limit`, not how many logs the org holds.
 */
export async function listApexLogs(
  connection: Connection,
  options: {
    filters: LogFilters;
    sortBy: LogSort;
    limit: number;
    /** From `readCursor`, for the same sort and filters. */
    after?: ResumePoint;
  },
): Promise<OrgLogPage> {
  const { filters, sortBy, limit, after } = options;
  const field = SORT_FIELD[sortBy];
  const where = whereClauses(filters);
  const afterValue = after && sortLiteral(sortBy, after.value);
  const pageWhere = after
    ? [
        ...where,
        `(${field} < ${afterValue} OR (${field} = ${afterValue} AND Id < ${quote(after.id)}))`,
      ]
    : where;
  const whereText = (clauses: string[]) =>
    clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

  // Counted once, on the first page: a `LIKE '%…%'` filter has the org read every log to count them.
  const counting: Promise<number> = after
    ? Promise.resolve(after.matchedCount)
    : connection
        .query(`SELECT COUNT() FROM ${APEX_LOG_SOBJECT}${whereText(where)}`)
        .then((count) => count.totalSize);
  const [page, matchedCount] = await Promise.all([
    // One past the limit, to learn whether another page follows.
    connection.query<ApexLogRecord>(
      `SELECT Id, LogUser.Username, Operation, Request, Status, StartTime, DurationMilliseconds, LogLength FROM ${APEX_LOG_SOBJECT}${whereText(pageWhere)} ORDER BY ${field} DESC, Id DESC LIMIT ${limit + 1}`,
    ),
    counting,
  ]);

  const records = page.records.slice(0, limit);
  const last = records[records.length - 1];
  return {
    rows: records.map(toRow),
    matchedCount,
    ...(page.records.length > limit &&
      last && {
        nextCursor: Buffer.from(
          JSON.stringify([
            listKey(sortBy, filters),
            last[field],
            last.Id,
            matchedCount,
          ] satisfies [string, unknown, string, number]),
        ).toString("base64url"),
      }),
  };
}

/** The ids of the newest stored logs, newest first. */
export async function latestApexLogIds(
  connection: Connection,
  count: number,
): Promise<string[]> {
  const result = await connection.query<{ Id: string }>(
    `SELECT Id FROM ${APEX_LOG_SOBJECT} ORDER BY StartTime DESC, Id DESC LIMIT ${count}`,
  );
  return result.records.map((record) => record.Id);
}

/** A stored log's text. */
export async function downloadApexLog(
  connection: Connection,
  id: string,
): Promise<string> {
  const body = await connection.request<string>(
    `/services/data/v${connection.getApiVersion()}/sobjects/${APEX_LOG_SOBJECT}/${id}/Body`,
  );
  return typeof body === "string" ? body : String(body);
}

/** How many same-length logs `findStoredLogId` downloads to tell them apart. */
const MAX_LOGS_TO_COMPARE = 5;

/**
 * The id Salesforce filed this log under, matched on its byte length and on
 * having been filed no earlier than this run.
 *
 * Salesforce hands out no log id for anonymous Apex, so this names the file
 * the way `sf` names it. The length is matched rather than the newest row
 * taken, and a failed query is reported and stepped over: the log is already
 * in hand and cannot be fetched again. Without the time bound, a log of the
 * same length from any earlier run answers the query.
 *
 * With a trace flag known to be live for the run, a single match is this
 * run's log, with no download; `unsure` says no flag was known live, so even
 * one match is checked. A repeat run of the same Apex matches the earlier runs
 * too, so when more than one matches, the newest few are downloaded and the one whose body is
 * this log names it: each body carries its own timestamps. None equal names
 * nothing, and the file goes under a timestamp, because
 * `apexlog_get_org_logs` trusts a file saved under an id to hold that log.
 */
export async function findStoredLogId(
  connection: Connection,
  userId: string,
  debugLog: string,
  startedAt: Date,
  unsure: boolean,
): Promise<string | undefined> {
  // `StartTime` is org time and `startedAt` is this machine's, so the bound is
  // slackened by the clock skew the two can carry between them.
  const since = new Date(startedAt.getTime() - CLOCK_SKEW_MS);
  try {
    const records = (await connection.sobject(APEX_LOG_SOBJECT).find(
      {
        LogUserId: userId,
        LogLength: Buffer.byteLength(debugLog, "utf-8"),
        StartTime: { $gte: toDateTimeLiteral(since) },
      },
      ["Id"],
      { sort: { StartTime: -1 }, limit: MAX_LOGS_TO_COMPARE },
    )) as { Id: string }[];
    if (records.length === 0 || (records.length === 1 && !unsure)) {
      return records[0]?.Id;
    }
    // One by one, newest first, since this run's log is most likely the newest.
    for (const { Id } of records) {
      if ((await downloadApexLog(connection, Id)) === debugLog) {
        return Id;
      }
    }
    return undefined;
  } catch (error) {
    console.error(
      `[apex-log-mcp] Could not match the debug log to a stored ApexLog: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
