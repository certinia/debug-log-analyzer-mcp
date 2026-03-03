/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { parse, ApexLog, LogLine } from "../ApexLogParser.js";
import { encode } from "@toon-format/toon";

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
    "Get a high-level summary of an Apex debug log including total execution time (in ms), method count, SOQL/DML totals, governor limits, and active namespaces. Best for a quick overview before deeper analysis.",
  inputSchema: getLogSummaryInputSchema,
  annotations: {
    title: "Get Apex Log Summary",
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

  const governorLimits: Record<string, { used: number; limit: number }> = {};
  Object.entries(apexLog.governorLimits).forEach(
    ([key, value]: [string, any]) => {
      if (key !== "byNamespace" && (value.used > 0 || value.limit > 0)) {
        governorLimits[key] = { used: value.used, limit: value.limit };
      }
    },
  );

  const logIssues = apexLog.logIssues.map((issue) => ({
    type: issue.type,
    summary: issue.summary,
  }));

  const summary = {
    file: path.basename(logFilePath),
    size: apexLog.size,
    totalExecutionTime: apexLog.duration.total / NS_TO_MS,
    totalMethods: countMethods(apexLog),
    totalSOQLQueries: apexLog.soqlCount.total,
    totalDMLOperations: apexLog.dmlCount.total,
    totalSOQLRows: apexLog.soqlRowCount.total,
    totalDMLRows: apexLog.dmlRowCount.total,
    governorLimits,
    namespaces: apexLog.namespaces,
    debugLevels: apexLog.debugLevels.map((d) => ({
      category: d.logCategory,
      level: d.logLevel,
    })),
    logIssues,
    parsingErrors: apexLog.parsingErrors.length,
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
