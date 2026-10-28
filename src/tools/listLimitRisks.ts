/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import type { ApexLog, DebugCategory, Limits } from "@apexdevtools/apex-log-parser";
import { defineAnalysisTool, type AnalysisArgs } from "./analysisTool.js";
import { capturedAt, type DeclaredLevel } from "../logLevels.js";
import {
  limitGatingCategory,
  omitEmpty,
  percentageOf,
  roundPercent,
  toLimitRows,
} from "./responseShaping.js";

/** Where a limit becomes worth reporting, when the caller names no other. */
export const WARNING_THRESHOLD = 80;

const listLimitRisksInputSchema = {
  threshold: z
    .number()
    .optional()
    .describe(
      `Minimum usedPercentage to report (default: ${WARNING_THRESHOLD})`,
    ),
};

export type LimitRisksArgs = AnalysisArgs<typeof listLimitRisksInputSchema>;

export interface LimitRisk {
  limit: string;
  used: number;
  max: number;
  usedPercentage: number;
}

/**
 * Every category that gates a limit figure, for the one case where no row
 * selects: with nothing returned there is nothing to qualify, but a reader
 * still has to tell "nothing is near a limit" from "limits were never logged".
 */
const ALL_LIMIT_GATING_CATEGORIES = [
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
   * The level each category gating a returned row was captured at, or every
   * gating category when no row was returned. Absent when the header declared
   * none of them: a level has no zero.
   */
  capturedAt?: DeclaredLevel[];
  /** Worst first. Empty means every limit is under the threshold. */
  atRisk: LimitRisk[];
}

export const listLimitRisksTool = defineAnalysisTool({
  name: "apexlog_list_limit_risks",
  title: "List Apex Log Limit Risks",
  description:
    "List the governor limits an Apex log transaction has nearly used up - CPU time, heap, SOQL queries and rows, SOSL queries, DML statements and rows, callouts and every other limit - worst first, with how much of each was used",
  input: listLimitRisksInputSchema,
  run: listLimitRisks,
});

function listLimitRisks(apexLog: ApexLog, args: LimitRisksArgs): LimitRiskResult {
  const { threshold = WARNING_THRESHOLD } = args;

  const atRisk = atRiskLimits(apexLog.governorLimits.peak, threshold);

  // The categories of the rows returned, so a level appears only where it
  // explains one of them - the same rule the ranking tool follows.
  const gating = atRisk.length
    ? atRisk.map(({ limit }) => limitGatingCategory(limit))
    : ALL_LIMIT_GATING_CATEGORIES;

  const result: LimitRiskResult = {
    threshold,
    ...omitEmpty({ capturedAt: capturedAt(apexLog, gating) }),
    atRisk,
  };

  return result;
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
