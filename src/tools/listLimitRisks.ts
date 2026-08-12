/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { encode } from "@toon-format/toon";
import type { GovernorLimits } from "../ApexLogParser.js";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import {
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

export interface LimitRiskResult {
  /**
   * What "at risk" meant for this call. The rows are a selection, so without it
   * an empty table cannot be told apart from a threshold nothing could reach.
   */
  threshold: number;
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
    atRisk: atRiskLimits(apexLog.governorLimits, threshold),
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
function atRiskLimits(
  governorLimits: GovernorLimits,
  threshold: number,
): LimitRisk[] {
  return toLimitRows(governorLimits)
    .filter((row) => row.max > 0)
    .map((row) => ({
      ...row,
      usedPercentage: roundPercent(percentageOf(row.used, row.max)),
    }))
    .filter((risk) => risk.usedPercentage >= threshold)
    .sort((a, b) => b.usedPercentage - a.usedPercentage);
}
