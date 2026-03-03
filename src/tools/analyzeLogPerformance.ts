/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { parse, ApexLog, LogLine } from "../ApexLogParser.js";
import { encode } from "@toon-format/toon";

export interface AnalyzeLogArgs {
  logFilePath: string;
  topMethods?: number;
  minDuration?: number;
  namespace?: string;
}

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
  selfPercentage: number;
}

export interface LogAnalysisResult {
  totalMethods: number;
  totalExecutionTime: number;
  slowestMethods: SlowMethod[];
  summary: string;
  recommendations: string[];
}

export const analyzeLogPerformanceTool = {
  name: "analyze_apex_log_performance",
  description:
    "Rank methods in an Apex debug log by self-execution time. Returns method names, durations, SOQL/DML counts, and optimization recommendations. Best for finding which specific methods to optimize.",
  annotations: {
    title: "Analyze Apex Log Performance",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      logFilePath: {
        type: "string",
        description: "Absolute path to the Apex debug log file (.log)",
      },
      topMethods: {
        type: "number",
        description: "Number of slowest methods to return (default: 10)",
        default: 10,
      },
      minDuration: {
        type: "number",
        description:
          "Minimum duration in nanoseconds to include a method. For reference: 1ms = 1,000,000ns, 1s = 1,000,000,000ns (default: 0)",
        default: 0,
      },
      namespace: {
        type: "string",
        description: "Filter methods by namespace",
      },
    },
    required: ["logFilePath"],
  },
};

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

  // Extract all methods with their performance data
  const methods = extractMethods(apexLog, minDuration, namespace);

  // Sort by self duration (descending)
  methods.sort((a, b) => b.selfDuration - a.selfDuration);

  // Take top N methods
  const slowestMethods = methods.slice(0, topMethods);

  const result: LogAnalysisResult = {
    totalMethods: methods.length,
    totalExecutionTime: apexLog.duration.total,
    slowestMethods,
    summary: generatePerformanceSummary(slowestMethods, apexLog.duration.total),
    recommendations: generateRecommendations(slowestMethods),
  };

  return {
    content: [
      {
        type: "text",
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
  totalTime: number,
): string {
  if (methods.length === 0) {
    return "No methods found matching the criteria.";
  }

  const slowestMethod = methods[0];
  const totalSlowMethodsTime = methods.reduce(
    (sum, method) => sum + method.selfDuration,
    0,
  );
  const percentageOfTotal =
    totalTime > 0 ? (totalSlowMethodsTime / totalTime) * 100 : 0;

  return `Analysis found ${methods.length} methods. The slowest method "${
    slowestMethod.name
  }" took ${(slowestMethod.selfDuration / 1000000).toFixed(
    2,
  )}ms (${slowestMethod.selfPercentage.toFixed(
    1,
  )}% of total execution time). The top ${
    methods.length
  } methods account for ${percentageOfTotal.toFixed(
    1,
  )}% of total execution time.`;
}

function generateRecommendations(methods: SlowMethod[]): string[] {
  const recommendations: string[] = [];

  methods.forEach((method, index) => {
    if (index < 3) {
      // Focus on top 3 methods
      const recommendation = getRecommendations(method);
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }
  });

  if (recommendations.length === 0) {
    recommendations.push(
      "Performance looks good! No obvious bottlenecks detected in the analyzed methods.",
    );
  }

  return recommendations;
}

function getRecommendations(method: SlowMethod): string | null {
  // High self time percentage, only include if self duration is significant
  if (method.selfPercentage > 10 && method.selfDuration > 100) {
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

  return null;
}
