/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { z } from "zod";
import { ApexLog } from "../ApexLogParser.js";
import { type SlowMethod, extractMethods } from "./analyzeLogPerformance.js";
import { encode } from "@toon-format/toon";
import { loadApexLog, logFilePathSchema } from "./apexLogSource.js";
import { NS_TO_MS, roundMs, roundPercent } from "./responseShaping.js";

export const findPerformanceBottlenecksInputSchema = {
  logFilePath: logFilePathSchema,
  analysisType: z
    .enum(["cpu", "database", "methods", "all"])
    .optional()
    .describe(
      "What to check: cpu = the CPU time limit, database = the SOQL query, DML statement and query row limits, methods = duration totals per namespace, all = all three (default).",
    ),
};

export type BottleneckArgs = z.infer<
  z.ZodObject<typeof findPerformanceBottlenecksInputSchema>
>;

export interface BottleneckResult {
  cpuBottlenecks?: Record<string, unknown>;
  databaseBottlenecks?: Record<string, unknown>;
  methodBottlenecks?: Record<string, unknown>;
  governorLimitWarnings?: Record<string, unknown>;
  note?: string;
}

export const findPerformanceBottlenecksToolConfig = {
  title: "Find Performance Bottlenecks",
  description:
    "Check whether an Apex log transaction is approaching governor limits (flags usage above 80%). Analyzes CPU time, SOQL/DML limits, query rows, and method execution patterns by namespace. Best for checking if a transaction is at risk of hitting governor limits.",
  inputSchema: findPerformanceBottlenecksInputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
};

export const WARNING_THRESHOLD = 80;

export async function findPerformanceBottlenecks(args: BottleneckArgs) {
  const { logFilePath, analysisType = "all" } = args;

  const apexLog = await loadApexLog(logFilePath);

  const hasCpuSection = analysisType === "cpu" || analysisType === "all";

  const bottlenecks: BottleneckResult = {};

  // Limits already spelled out by a dedicated section, so the generic warning
  // block does not report them a second time.
  const reportedLimits = new Set<string>();

  if (hasCpuSection) {
    const cpu = analyzeCPUBottlenecks(apexLog);
    if (Object.keys(cpu).length > 0) {
      bottlenecks.cpuBottlenecks = cpu;
      reportedLimits.add("cpuTime");
    }
  }

  if (analysisType === "database" || analysisType === "all") {
    const db = analyzeDatabaseBottlenecks(apexLog);
    if (Object.keys(db).length > 0) {
      bottlenecks.databaseBottlenecks = db;
      Object.keys(db).forEach((limit) => reportedLimits.add(limit));
    }
  }

  if (analysisType === "methods" || analysisType === "all") {
    const methods = analyzeMethodBottlenecks(apexLog);
    if (Object.keys(methods).length > 0) {
      bottlenecks.methodBottlenecks = methods;
    }
  }

  const governorWarnings = analyzeGovernorLimits(apexLog, reportedLimits);
  if (Object.keys(governorWarnings).length > 0) {
    bottlenecks.governorLimitWarnings = governorWarnings;
  }

  if (Object.keys(bottlenecks).length === 0) {
    bottlenecks.note = "No bottlenecks or governor limit warnings found.";
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
      cpuUsagePercentage: roundPercent(cpuUsagePercent),
      warning: "High CPU usage - consider optimizing algorithms",
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
      percentage: roundPercent(soqlPercentage),
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
      percentage: roundPercent(dmlPercentage),
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
      percentage: roundPercent(queryRowsPercentage),
    };
  }

  return bottlenecks;
}

function analyzeMethodBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const methods = extractMethods(apexLog, 0);
  const methodsByNamespace = methods.reduce(
    (acc: Record<string, SlowMethod[]>, method) => {
      (acc[method.namespace] ??= []).push(method);
      return acc;
    },
    {},
  );

  return {
    totalMethods: methods.length,
    methodsByNamespace: Object.entries(methodsByNamespace).map(([ns, group]) => ({
      namespace: ns,
      methodCount: group.length,
      totalDuration: roundMs(
        group.reduce((sum: number, m: SlowMethod) => sum + m.duration, 0) /
          NS_TO_MS,
      ),
    })),
  };
}

function analyzeGovernorLimits(
  apexLog: ApexLog,
  reportedLimits: Set<string>,
): Record<string, unknown> {
  const limits = apexLog.governorLimits;

  const result: Record<string, unknown> = {};

  Object.entries(limits).forEach(([key, value]: [string, any]) => {
    if (key === "byNamespace") return;
    if (reportedLimits.has(key)) return;
    if (value.limit > 0) {
      const percentage = (value.used / value.limit) * 100;
      if (percentage > WARNING_THRESHOLD) {
        result[key] = value;
      }
    }
  });

  return result;
}
