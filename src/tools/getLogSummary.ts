/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { ApexLog } from "../ApexLogParser.js";
import { encode } from "@toon-format/toon";
import { loadApexLog, isMethodNode, walkLog } from "./apexLogSource.js";
import {
  NS_TO_MS,
  omitEmpty,
  roundMs,
  toLimitRows,
} from "./responseShaping.js";

export const getLogSummaryInputSchema = {
  logFilePath: z
    .string()
    .describe("Absolute path to the Apex debug log file (.log)"),
};

export type LogSummaryArgs = z.infer<
  z.ZodObject<typeof getLogSummaryInputSchema>
>;

export const getLogSummaryToolConfig = {
  title: "Get Apex Log Summary",
  description:
    "Get a high-level summary of an Apex debug log including total execution time, method count, SOQL/DML totals, governor limits, debug levels and active namespaces. Best for a quick overview before deeper analysis.",
  inputSchema: getLogSummaryInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

export async function getLogSummary(args: LogSummaryArgs) {
  const { logFilePath } = args;

  const apexLog = await loadApexLog(logFilePath);

  const logIssues = apexLog.logIssues.map((issue) => ({
    type: issue.type,
    summary: issue.summary,
  }));

  // Every limit and every category is reported, at zero or NONE included: the
  // caller has to be able to say "no DML statements ran" and "DB logging was
  // off, so that detail is missing" without guessing from what is absent.
  const summary = {
    size: apexLog.size,
    totalExecutionTime: roundMs(apexLog.duration.total / NS_TO_MS),
    totalMethods: countMethods(apexLog),
    totalSOQLQueries: apexLog.soqlCount.total,
    totalDMLOperations: apexLog.dmlCount.total,
    totalSOQLRows: apexLog.soqlRowCount.total,
    totalDMLRows: apexLog.dmlRowCount.total,
    governorLimits: toLimitRows(apexLog.governorLimits),
    namespaces: apexLog.namespaces,
    debugLevels: apexLog.debugLevels.map((level) => ({
      category: level.logCategory,
      level: level.logLevel,
    })),
    parsingErrors: apexLog.parsingErrors.length,
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

function countMethods(apexLog: ApexLog): number {
  let count = 0;
  walkLog(apexLog, (node) => {
    if (isMethodNode(node)) {
      count++;
    }
  });
  return count;
}
