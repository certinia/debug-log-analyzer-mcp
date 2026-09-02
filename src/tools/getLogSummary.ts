/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import type { ApexLog } from "@apexdevtools/apex-log-parser";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import {
  declaredLevels,
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
    debugLevels: declaredLevels(apexLog),
    governorLimits: toLimitRows(apexLog.governorLimits.peak),
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
 * Two shapes, and neither implies the other: the log ran out mid-frame, which
 * marks the line that lost its exit event, or a section was skipped, which
 * leaves the events paired up around the gap so only the log issue says it is
 * there. The parser now models both on the root, as `truncation.regions` and
 * `truncatedEvents` — #100 moves this onto them and deletes the walk.
 */
function isTruncated(apexLog: ApexLog): boolean {
  return (
    apexLog.children.some((child) => child.isTruncated) ||
    apexLog.logIssues.some((issue) => TRUNCATION_ISSUES.has(issue.summary))
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
