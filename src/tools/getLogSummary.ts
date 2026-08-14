/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import type { ApexLog, LogLine } from "../ApexLogParser.js";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import {
  listOperations,
  logCategoryOf,
  OPERATION_KINDS,
  type Operation,
  type OperationKind,
} from "./operations.js";
import {
  NS_TO_MS,
  omitEmpty,
  percentageOf,
  roundMs,
  roundPercent,
  toLimitRows,
  toNamespaceLimitRows,
  type LimitRow,
  type NamespaceLimitRow,
} from "./responseShaping.js";

export const getLogSummaryInputSchema = {
  logFilePath: logFilePathSchema,
};

export type LogSummaryArgs = z.infer<
  z.ZodObject<typeof getLogSummaryInputSchema>
>;

export const getLogSummaryToolConfig = {
  title: "Get Apex Log Summary",
  description:
    "Get a high-level summary of an Apex debug log: how long the transaction ran, where the time went by kind of operation, every governor limit it and each namespace consumed, the debug levels it was logged at, and whether the log is complete. Best for a quick overview before deeper analysis.",
  inputSchema: getLogSummaryInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/**
 * Where the transaction's time went, one row per kind of operation.
 *
 * `logCategory` is the trace category that decides whether the kind reaches the
 * log at all, so a zero row can be read against `debugLevels`: `soql 0` beside
 * `DB NONE` means the queries were not logged, and beside `DB FINEST` means
 * none ran.
 */
interface KindRow {
  kind: OperationKind;
  logCategory: string;
  operationCount: number;
  durationSelfMs: number;
  selfPercentage: number;
}

interface LogSummaryResult {
  fileSizeBytes: number;
  durationTotalMs: number;
  /** True when the log is partial, so every figure in it is a floor, not a total. */
  truncated: boolean;
  parsingErrorCount: number;
  namespaces: string[];
  debugLevels: { logCategory: string; level: string }[];
  governorLimits: LimitRow[];
  limitsByNamespace: NamespaceLimitRow[];
  timeByKind: KindRow[];
  logIssues?: { type: string; summary: string }[];
}

export async function getLogSummary(args: LogSummaryArgs) {
  const { logFilePath } = args;

  const apexLog = await loadApexLog(logFilePath);
  const durationTotalNs = apexLog.duration.total;

  const logIssues = apexLog.logIssues.map((issue) => ({
    type: issue.type,
    summary: issue.summary,
  }));

  // Every limit and every kind is reported, at zero included: the caller has to
  // be able to say "no DML statements ran" and "DB logging was off, so that
  // detail is missing" without guessing from what is absent.
  const summary: LogSummaryResult = {
    fileSizeBytes: apexLog.size,
    durationTotalMs: roundMs(durationTotalNs / NS_TO_MS),
    truncated: isTruncated(apexLog),
    parsingErrorCount: apexLog.parsingErrors.length,
    namespaces: apexLog.namespaces,
    debugLevels: apexLog.debugLevels.map((level) => ({
      logCategory: level.logCategory,
      level: level.logLevel,
    })),
    governorLimits: toLimitRows(apexLog.governorLimits),
    limitsByNamespace: toNamespaceLimitRows(apexLog.governorLimits.byNamespace),
    timeByKind: timeByKind(listOperations(apexLog), durationTotalNs),
    ...omitEmpty({ logIssues }),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: encode(summary),
      },
    ],
  };
}

/** The log issues the parser raises for a section of log it never saw. */
const TRUNCATION_ISSUES = new Set(["Skipped-Lines", "Max-Size-reached"]);

/**
 * Whether part of the transaction is missing from the log.
 *
 * Two shapes, and neither implies the other. The log ran out: the parser marks
 * the line that lost its exit event, not the log — the root is a pseudo node it
 * never terminates, so `apexLog.isTruncated` is always false, and truncation
 * propagates up to a top-level line, so those are what is tested. Or a section
 * was skipped: the events can still pair up around the gap, leaving no node
 * marked, and only the log issue says the gap is there.
 */
function isTruncated(apexLog: ApexLog): boolean {
  // isTruncated is declared on Method, a subclass, so it is read off the node
  // rather than tested with instanceof. A line without one cannot be truncated.
  return (
    apexLog.children.some(
      (child) => (child as LogLine & { isTruncated?: boolean }).isTruncated,
    ) || apexLog.logIssues.some((issue) => TRUNCATION_ISSUES.has(issue.summary))
  );
}

function timeByKind(
  operations: Operation[],
  durationTotalNs: number,
): KindRow[] {
  // Seeded with every kind, so the loop only ever adds to a row that is there
  // and the kinds nothing ran under are still reported, at zero.
  const totals = Object.fromEntries(
    OPERATION_KINDS.map((kind) => [kind, { operationCount: 0, selfNs: 0 }]),
  ) as Record<OperationKind, { operationCount: number; selfNs: number }>;

  operations.forEach(({ kind, durationSelfNs }) => {
    const total = totals[kind];
    total.operationCount += 1;
    total.selfNs += durationSelfNs;
  });

  return OPERATION_KINDS.map((kind) => {
    const { operationCount, selfNs } = totals[kind];
    return {
      kind,
      logCategory: logCategoryOf(kind),
      operationCount,
      durationSelfMs: roundMs(selfNs / NS_TO_MS),
      selfPercentage: roundPercent(percentageOf(selfNs, durationTotalNs)),
    };
  });
}
