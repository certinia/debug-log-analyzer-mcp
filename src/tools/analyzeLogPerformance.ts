/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { z } from "zod";
import { parse, ApexLog, LogLine } from "../ApexLogParser.js";
import { encode } from "@toon-format/toon";

export const analyzeLogPerformanceInputSchema = {
  logFilePath: z
    .string()
    .describe("Absolute path to the Apex debug log file (.log)"),
  topMethods: z
    .number()
    .optional()
    .describe("Number of slowest methods to return (default: 10)"),
  minDuration: z
    .number()
    .optional()
    .describe(
      "Minimum duration in milliseconds to include a method (default: 0)",
    ),
  namespace: z.string().optional().describe("Filter methods by namespace"),
};

export type AnalyzeLogArgs = z.infer<
  z.ZodObject<typeof analyzeLogPerformanceInputSchema>
>;

export const analyzeLogPerformanceToolConfig = {
  title: "Analyze Apex Log Performance",
  description:
    "Rank methods in an Apex debug log by self-execution time. Returns method names, durations (in ms), SOQL/DML counts, and optimization recommendations. Best for finding which specific methods to optimize.",
  inputSchema: analyzeLogPerformanceInputSchema,
  annotations: {
    title: "Analyze Apex Log Performance",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export interface SlowMethod {
  name: string;
  duration: number;
  selfDuration: number;
  namespace: string;
  lineNumber: string | number | null;
  dmlCount: number;
  soqlCount: number;
  dmlRows: number;
  soqlRows: number;
  thrownCount: number;
  soslCount: number;
  soslRows: number;
  selfPercentage: number;
}

export interface LogAnalysisResult {
  totalMethods: number;
  totalExecutionTime: number;
  slowestMethods: SlowMethod[];
  summary: string;
  recommendations: string[];
}

const NS_TO_MS = 1_000_000;

export async function analyzeLogPerformance(args: AnalyzeLogArgs) {
  const { logFilePath, topMethods = 10, minDuration = 0, namespace } = args;

  // Validate file exists
  try {
    await fs.access(logFilePath);
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  // Read and parse log file
  const logContent = await fs.readFile(logFilePath, "utf-8");
  const apexLog = parse(logContent);

  // Convert ms input to ns for internal filtering
  const minDurationNs = minDuration * NS_TO_MS;

  // Extract all methods with their performance data
  const methods = extractMethods(apexLog, minDurationNs, namespace);

  // Sort by self duration (descending)
  methods.sort((a, b) => b.selfDuration - a.selfDuration);

  // Take top N methods
  const slowestMethods = methods.slice(0, topMethods);

  const msMethods = slowestMethods.map((m) => ({
    ...m,
    duration: m.duration / NS_TO_MS,
    selfDuration: m.selfDuration / NS_TO_MS,
  }));

  const result: LogAnalysisResult = {
    totalMethods: methods.length,
    totalExecutionTime: apexLog.duration.total / NS_TO_MS,
    slowestMethods: msMethods,
    summary: generatePerformanceSummary(
      msMethods,
      apexLog.duration.total / NS_TO_MS,
    ),
    recommendations: generateRecommendations(msMethods),
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

export function extractMethods(
  apexLog: ApexLog,
  minDuration: number,
  namespaceFilter?: string,
): SlowMethod[] {
  const methods: SlowMethod[] = [];
  const totalTime = apexLog.duration.total;

  const traverse = (node: LogLine) => {
    if (
      node.type === "CODE_UNIT_STARTED" || // Entry point
      node.type === "METHOD_ENTRY" || // Methods
      (node as any).subCategory === "Method"
    ) {
      if (node.duration.total >= minDuration) {
        if (!namespaceFilter || node.namespace === namespaceFilter) {
          methods.push({
            name: node.text || "Unknown Method",
            duration: node.duration.total,
            selfDuration: node.duration.self,
            namespace: node.namespace || "default",
            lineNumber: node.lineNumber,
            dmlCount: node.dmlCount.total,
            soqlCount: node.soqlCount.total,
            dmlRows: node.dmlRowCount.total,
            soqlRows: node.soqlRowCount.total,
            thrownCount: node.totalThrownCount,
            soslCount: node.soslCount.total,
            soslRows: node.soslRowCount.total,
            selfPercentage:
              totalTime > 0 ? (node.duration.self / totalTime) * 100 : 0,
          });
        }
      }
    }

    if (node.children) {
      node.children.forEach((child: LogLine) => traverse(child));
    }
  };

  traverse(apexLog);
  return methods;
}

function generatePerformanceSummary(
  methods: SlowMethod[],
  totalTimeMs: number,
): string {
  if (methods.length === 0) {
    return "No methods found matching the criteria.";
  }

  const slowestMethod = methods[0]!;
  const totalSlowMethodsTime = methods.reduce(
    (sum, method) => sum + method.selfDuration,
    0,
  );
  const percentageOfTotal =
    totalTimeMs > 0 ? (totalSlowMethodsTime / totalTimeMs) * 100 : 0;

  return `Analysis found ${methods.length} methods. The slowest method "${slowestMethod.name}" took ${slowestMethod.selfDuration.toFixed(2)}ms (${slowestMethod.selfPercentage.toFixed(1)}% of total execution time). The top ${methods.length} methods account for ${percentageOfTotal.toFixed(1)}% of total execution time.`;
}

function generateRecommendations(methods: SlowMethod[]): string[] {
  const recommendations: string[] = [];

  for (const method of methods.slice(0, 3)) {
    const recommendation = getRecommendation(method);
    if (recommendation) {
      recommendations.push(recommendation);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "Performance looks good! No obvious bottlenecks detected in the analyzed methods.",
    );
  }

  return recommendations;
}

function getRecommendation(method: SlowMethod): string | null {
  if (method.selfPercentage > 10 && method.selfDuration > 0.1) {
    return `Method "${method.name}" consumes ${method.selfPercentage.toFixed(
      1,
    )}% self execution time. Consider if it can be optimized to make it faster, check how many times it is called and if that can be reduced.`;
  }
  if (method.soqlRows > 1000) {
    return `Method "${method.name}" processes ${method.soqlRows} SOQL rows. Consider adding WHERE clauses or using pagination.`;
  }
  if (method.soqlCount > 5) {
    return `Method "${method.name}" executes ${method.soqlCount} SOQL queries. Consider reducing query count through bulkification or caching.`;
  }
  if (method.dmlCount > 3) {
    return `Method "${method.name}" performs ${method.dmlCount} DML operations. Consider bulkifying DML operations.`;
  }
  if (method.soslCount > 3) {
    return `Method "${method.name}" executes ${method.soslCount} SOSL searches. Consider reducing search count or caching results.`;
  }

  return null;
}
