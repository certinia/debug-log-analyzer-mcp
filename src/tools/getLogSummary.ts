/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import path from "path";
import { parse, ApexLog, LogLine } from "../ApexLogParser";

export interface LogSummaryArgs {
  logFilePath: string;
}

export const getLogSummaryTool = {
  name: "get_apex_log_summary",
  description:
    "Get a high-level summary of an Apex debug log including total execution time, method count, and governor limits",
  inputSchema: {
    type: "object",
    properties: {
      logFilePath: {
        type: "string",
        description: "Absolute path to the Apex debug log file (.log)",
      },
    },
    required: ["logFilePath"],
  },
};

export async function getLogSummary(args: LogSummaryArgs) {
  const { logFilePath } = args;

  try {
    await fs.access(logFilePath);
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  const logContent = await fs.readFile(logFilePath, "utf-8");
  const apexLog = parse(logContent);

  const summary = {
    file: path.basename(logFilePath),
    totalExecutionTime: apexLog.duration.total,
    totalMethods: countMethods(apexLog),
    totalSOQLQueries: apexLog.soqlCount.total,
    totalDMLOperations: apexLog.dmlCount.total,
    totalSOQLRows: apexLog.soqlRowCount.total,
    totalDMLRows: apexLog.dmlRowCount.total,
    governorLimits: {
      cpuTime: apexLog.governorLimits.cpuTime,
      heapSize: apexLog.governorLimits.heapSize,
      soqlQueries: apexLog.governorLimits.soqlQueries,
      dmlStatements: apexLog.governorLimits.dmlStatements,
    },
    namespaces: apexLog.namespaces,
    logIssues: apexLog.logIssues.length,
    parsingErrors: apexLog.parsingErrors.length,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(summary, null, 2),
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
