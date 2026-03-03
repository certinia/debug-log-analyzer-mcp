/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { z } from "zod";
import { parse, ApexLog } from "../ApexLogParser.js";
import { SlowMethod, extractMethods } from "./analyzeLogPerformance.js";
import { encode } from "@toon-format/toon";

export const findPerformanceBottlenecksInputSchema = {
  logFilePath: z
    .string()
    .describe("Absolute path to the Apex debug log file (.log)"),
  analysisType: z
    .enum(["cpu", "database", "methods", "all"])
    .optional()
    .describe(
      'Type of analysis: "cpu" checks CPU time governor limit, "database" checks SOQL query/DML statement/query row limits, "methods" groups methods by namespace with duration totals, "all" runs all three (default)',
    ),
};

export type BottleneckArgs = z.infer<
  z.ZodObject<typeof findPerformanceBottlenecksInputSchema>
>;

export interface BottleneckResult {
  cpuBottlenecks?: Record<string, unknown>;
  databaseBottlenecks?: Record<string, unknown>;
  methodBottlenecks?: Record<string, unknown>;
  governorLimitWarnings: Record<string, unknown>;
}

export const findPerformanceBottlenecksToolConfig = {
  title: "Find Performance Bottlenecks",
  description:
    "Check whether an Apex log transaction is approaching governor limits (flags usage above 80%). Analyzes CPU time, SOQL/DML limits, query rows, and method execution patterns by namespace. Best for checking if a transaction is at risk of hitting governor limits.",
  inputSchema: findPerformanceBottlenecksInputSchema,
  annotations: {
    title: "Find Performance Bottlenecks",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const WARNING_THRESHOLD = 80;

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
        type: "text" as const,
        text: encode(bottlenecks),
      },
    ],
  };
}

function analyzeCPUBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const { used, limit } = apexLog.governorLimits.cpuTime;
  const cpuUsagePercent = limit > 0 ? (used / limit) * 100 : 0;

  if (cpuUsagePercent > WARNING_THRESHOLD) {
    return {
      cpuTimeUsed: used,
      cpuTimeLimit: limit,
      cpuUsagePercentage: cpuUsagePercent,
      warning: "High CPU usage detected - consider optimizing algorithms",
    };
  }

  return {};
}

function analyzeDatabaseBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const governorLimits = apexLog.governorLimits;
  const bottlenecks: Record<string, unknown> = {};

  const soqlPercentage =
    governorLimits.soqlQueries.limit > 0
      ? (governorLimits.soqlQueries.used / governorLimits.soqlQueries.limit) *
        100
      : 0;

  if (soqlPercentage > WARNING_THRESHOLD) {
    bottlenecks.soqlQueries = {
      used: governorLimits.soqlQueries.used,
      limit: governorLimits.soqlQueries.limit,
      percentage: soqlPercentage,
    };
  }

  const dmlPercentage =
    governorLimits.dmlStatements.limit > 0
      ? (governorLimits.dmlStatements.used /
          governorLimits.dmlStatements.limit) *
        100
      : 0;

  if (dmlPercentage > WARNING_THRESHOLD) {
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

  if (queryRowsPercentage > WARNING_THRESHOLD) {
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
    {},
  );

  return {
    totalMethods: methods.length,
    methodsByNamespace: Object.keys(methodsByNamespace).map((ns) => ({
      namespace: ns,
      methodCount: methodsByNamespace[ns].length,
      totalDuration: methodsByNamespace[ns].reduce(
        (sum: number, m: SlowMethod) => sum + m.duration,
        0,
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
      if (percentage > WARNING_THRESHOLD) {
        warnings.push(
          `${key}: ${percentage.toFixed(1)}% of limit used (${value.used}/${
            value.limit
          })`,
        );
      }
    }
  });

  const reducedLimits = Object.entries(limits).reduce(
    (acc: Record<string, unknown>, [key, value]: [string, any]) => {
      if (key !== "byNamespace" && value.limit > 0) {
        const percentage = (value.used / value.limit) * 100;
        if (percentage > WARNING_THRESHOLD) {
          acc[key] = value;
        }
      }
      return acc;
    },
    {},
  );

  return warnings.length === 0
    ? { note: "No governor limits approaching their thresholds." }
    : {
        warnings,
        // Only include limits with usage
        details: reducedLimits,
        note: undefined,
      };
}
