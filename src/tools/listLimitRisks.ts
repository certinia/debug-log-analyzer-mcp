/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import type {
  DebugCategory,
  Limits,
} from "@apexdevtools/apex-log-parser/types";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import { capturedAt, type DeclaredLevel } from "./operations.js";
import {
  omitEmpty,
  percentageOf,
  roundPercent,
  toLimitRows,
} from "./responseShaping.js";

/** Where a limit becomes worth reporting, when the caller names no other. */
export const WARNING_THRESHOLD = 80;

export const listLimitRisksInputSchema = {
  logFilePath: logFilePathSchema,
  threshold: z
    .number()
    .optional()
    .describe(
      `Report a limit once it is this percentage consumed (default: ${WARNING_THRESHOLD})`,
    ),
};

export type LimitRisksArgs = z.infer<
  z.ZodObject<typeof listLimitRisksInputSchema>
>;

export interface LimitRisk {
  limit: string;
  used: number;
  max: number;
  usedPercentage: number;
}

/**
 * The categories that decide whether a limit figure reached the log at all.
 *
 * Every limit but heap is read from the cumulative blocks, which the parser
 * stamps `apexProfiling` — `CUMULATIVE_LIMIT_USAGE` at INFO and
 * `LIMIT_USAGE_FOR_NS` at FINEST. `heapSize` comes from `HEAP_ALLOCATE`, which
 * is `apexCode` at FINER. So these two levels are what say whether a low or
 * absent figure is the transaction's or the trace flag's.
 *
 * A union over all thirteen limits, not the ones a call selected: `apexCode` is
 * reported beside a risk list that holds no `heapSize`. Narrowing it needs a
 * gating category per limit metric, which the parser does not publish.
 */
const LIMIT_GATING_CATEGORIES = [
  "apexCode",
  "apexProfiling",
] as const satisfies readonly DebugCategory[];

export interface LimitRiskResult {
  /**
   * What "at risk" meant for this call. The rows are a selection, so without it
   * an empty table cannot be told apart from a threshold nothing could reach.
   */
  threshold: number;
  /**
   * The level each category that gates a limit figure was captured at. Absent
   * when the header declared neither: a level has no zero.
   */
  capturedAt?: DeclaredLevel[];
  /** Worst first. Empty means every limit is under the threshold. */
  atRisk: LimitRisk[];
}

export const listLimitRisksToolConfig = {
  title: "List Apex Log Limit Risks",
  description:
    "List the governor limits an Apex log transaction has nearly consumed — CPU time, heap, SOQL and SOSL queries, DML statements, and the rows each returned or wrote — worst first, with how much of each was used. Best for checking whether a transaction is at risk of failing on a limit.",
  inputSchema: listLimitRisksInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

export async function listLimitRisks(args: LimitRisksArgs) {
  const { logFilePath, threshold = WARNING_THRESHOLD } = args;

  const apexLog = await loadApexLog(logFilePath);

  const result: LimitRiskResult = {
    threshold,
    ...omitEmpty({ capturedAt: capturedAt(apexLog, LIMIT_GATING_CATEGORIES) }),
    atRisk: atRiskLimits(apexLog.governorLimits.peak, threshold),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: encode(result),
      },
    ],
  };
}

/**
 * The limits at or above the threshold, worst first.
 *
 * A limit with no ceiling is skipped rather than reported at zero: the log did
 * not say what it was, so no share of it can be worked out.
 */
function atRiskLimits(limits: Limits, threshold: number): LimitRisk[] {
  return toLimitRows(limits)
    .filter((row) => row.max > 0)
    .map((row) => ({
      ...row,
      usedPercentage: roundPercent(percentageOf(row.used, row.max)),
    }))
    .filter((risk) => risk.usedPercentage >= threshold)
    .sort((a, b) => b.usedPercentage - a.usedPercentage);
}
