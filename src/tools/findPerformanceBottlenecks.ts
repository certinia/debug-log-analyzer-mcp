/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { parse, ApexLog } from "../ApexLogParser.js";
import { SlowMethod, extractMethods } from "./analyzeLogPerformance.js";

export interface BottleneckArgs {
  logFilePath: string;
  analysisType?: "cpu" | "database" | "methods" | "all";
}

interface BottleneckResult {
  cpuBottlenecks?: Record<string, unknown>;
  databaseBottlenecks?: Record<string, unknown>;
  methodBottlenecks?: Record<string, unknown>;
  governorLimitWarnings: Record<string, unknown>;
}

export const findPerformanceBottlenecksTool = {
  name: "find_performance_bottlenecks",
  description:
    "Identify performance bottlenecks in an Apex log by analyzing CPU time, database operations, and method execution patterns",
  inputSchema: {
    type: "object",
    properties: {
      logFilePath: {
        type: "string",
        description: "Absolute path to the Apex debug log file (.log)",
      },
      analysisType: {
        type: "string",
        enum: ["cpu", "database", "methods", "all"],
        description: "Type of bottleneck analysis to perform",
        default: "all",
      },
    },
    required: ["logFilePath"],
  },
};

export async function findPerformanceBottlenecks(args: BottleneckArgs) {
  const { logFilePath, analysisType = "all" } = args;

  try {
    await fs.access(logFilePath);
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  const logContent = await fs.readFile(logFilePath, "utf-8");
  const apexLog = parse(logContent);

  const bottlenecks: BottleneckResult = {
    governorLimitWarnings: analyzeGovernorLimits(apexLog),
  };

  if (analysisType === "cpu" || analysisType === "all") {
    bottlenecks.cpuBottlenecks = analyzeCPUBottlenecks(apexLog);
  }

  if (analysisType === "database" || analysisType === "all") {
    bottlenecks.databaseBottlenecks = analyzeDatabaseBottlenecks(apexLog);
  }

  if (analysisType === "methods" || analysisType === "all") {
    bottlenecks.methodBottlenecks = analyzeMethodBottlenecks(apexLog);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(bottlenecks, null, 2),
      },
    ],
  };
}

function analyzeCPUBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const governorLimits = apexLog.governorLimits;
  const cpuUsagePercent =
    governorLimits.cpuTime.limit > 0
      ? (governorLimits.cpuTime.used / governorLimits.cpuTime.limit) * 100
      : 0;

  return cpuUsagePercent > 80
    ? {
        cpuTimeUsed: governorLimits.cpuTime.used,
        cpuTimeLimit: governorLimits.cpuTime.limit,
        cpuUsagePercentage: cpuUsagePercent,
        warning: "High CPU usage detected - consider optimizing algorithms",
      }
    : {};

}

function analyzeDatabaseBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const governorLimits = apexLog.governorLimits;
  const bottlenecks: Record<string, unknown> = {};

  const soqlPercentage =
    governorLimits.soqlQueries.limit > 0
      ? (governorLimits.soqlQueries.used / governorLimits.soqlQueries.limit) * 100
      : 0;

  if (soqlPercentage > 80) {
    bottlenecks.soqlQueries = {
      used: governorLimits.soqlQueries.used,
      limit: governorLimits.soqlQueries.limit,
      percentage: soqlPercentage,
    };
  }

  const dmlPercentage =
    governorLimits.dmlStatements.limit > 0
      ? (governorLimits.dmlStatements.used / governorLimits.dmlStatements.limit) * 100
      : 0;

  if (dmlPercentage > 80) {
    bottlenecks.dmlStatements = {
      used: governorLimits.dmlStatements.used,
      limit: governorLimits.dmlStatements.limit,
      percentage: dmlPercentage,
    };
  }

  const queryRowsPercentage =
    governorLimits.queryRows.limit > 0
      ? (governorLimits.queryRows.used / governorLimits.queryRows.limit) * 100
      : 0;

  if (queryRowsPercentage > 80) {
    bottlenecks.queryRows = {
      used: governorLimits.queryRows.used,
      limit: governorLimits.queryRows.limit,
      percentage: queryRowsPercentage,
    };
  }

  return bottlenecks;
}

function analyzeMethodBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const methods = extractMethods(apexLog, 0);
  const methodsByNamespace = methods.reduce(
    (acc: Record<string, SlowMethod[]>, method) => {
      if (!acc[method.namespace]) {
        acc[method.namespace] = [];
      }
      acc[method.namespace].push(method);
      return acc;
    },
    {}
  );

  return {
    totalMethods: methods.length,
    methodsByNamespace: Object.keys(methodsByNamespace).map((ns) => ({
      namespace: ns,
      methodCount: methodsByNamespace[ns].length,
      totalDuration: methodsByNamespace[ns].reduce(
        (sum: number, m: SlowMethod) => sum + m.duration,
        0
      ),
    })),
  };
}

function analyzeGovernorLimits(apexLog: ApexLog): Record<string, unknown> {
  const limits = apexLog.governorLimits;
  const warnings: string[] = [];

  Object.entries(limits).forEach(([key, value]: [string, any]) => {
    if (key !== "byNamespace" && value.limit > 0) {
      const percentage = (value.used / value.limit) * 100;
      if (percentage > 50) {
        warnings.push(
          `${key}: ${percentage.toFixed(1)}% of limit used (${value.used}/${
            value.limit
          })`
        );
      }
    }
  });

  const reducedLimits = Object.entries(limits).reduce(
    (acc: Record<string, unknown>, [key, value]: [string, any]) => {
      if (value.used > 0) {
        acc[key] = value;
      }
      return acc;
    },
    {}
  );


  return {
    warnings,
    // Only include limits with usage
    details: reducedLimits,
    note:
      warnings.length === 0
        ? "No governor limits approaching their thresholds detected."
        : undefined,
  };
}
