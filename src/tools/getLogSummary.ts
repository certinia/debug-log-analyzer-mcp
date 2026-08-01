/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { z } from "zod";
import { parse, ApexLog, LogLine } from "../ApexLogParser.js";
import { encode } from "@toon-format/toon";
import { omitEmpty, roundMs, toLimitRows } from "./responseShaping.js";

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
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const NS_TO_MS = 1_000_000;

export async function getLogSummary(args: LogSummaryArgs) {
  const { logFilePath } = args;

  try {
    await fs.access(logFilePath);
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  const logContent = await fs.readFile(logFilePath, "utf-8");
  const apexLog = parse(logContent);

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
  const traverse = (node: LogLine) => {
    if (
      node.type === "METHOD_ENTRY" ||
      (node as any).subCategory === "Method"
    ) {
      count++;
    }
    if (node.children) {
      node.children.forEach((child: LogLine) => traverse(child));
    }
  };
  traverse(apexLog);
  return count;
}
