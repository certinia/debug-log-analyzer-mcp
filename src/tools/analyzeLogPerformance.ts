/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { z } from "zod";
import { parse, ApexLog, LogLine } from "../ApexLogParser.js";
import { encode } from "@toon-format/toon";
import { omitEmpty, roundMs, roundPercent } from "./responseShaping.js";

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
    "Rank methods in an Apex debug log by self-execution time. Returns method names, durations (in ms), SOQL/DML counts, the share of total runtime the ranked methods account for, and optimization recommendations. Best for finding which specific methods to optimize. Every method row carries the full column set; only `recommendations` is omitted, and only when nothing stood out.",
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
  /**
   * Share of total execution time the returned methods account for between them.
   * A low figure says the cost is spread across the rest of the transaction
   * rather than concentrated in these methods — the one thing the table itself
   * does not say.
   */
  topMethodsSelfPercentage: number;
  slowestMethods: SlowMethod[];
  /** Omitted when nothing stands out; an empty list says the same thing. */
  recommendations?: string[];
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
    duration: roundMs(m.duration / NS_TO_MS),
    selfDuration: roundMs(m.selfDuration / NS_TO_MS),
    selfPercentage: roundPercent(m.selfPercentage),
  }));

  // The column set is fixed so that every call returns the same shape, and so
  // that a zero SOQL count reads as "none" rather than "not measured".
  const result: LogAnalysisResult = {
    totalMethods: methods.length,
    totalExecutionTime: roundMs(apexLog.duration.total / NS_TO_MS),
    topMethodsSelfPercentage: roundPercent(
      slowestMethods.reduce((total, m) => total + m.selfPercentage, 0),
    ),
    slowestMethods: msMethods.map((m) => ({
      name: m.name,
      duration: m.duration,
      selfDuration: m.selfDuration,
      selfPercentage: m.selfPercentage,
      namespace: m.namespace,
      lineNumber: m.lineNumber,
      dmlCount: m.dmlCount,
      soqlCount: m.soqlCount,
      dmlRows: m.dmlRows,
      soqlRows: m.soqlRows,
      thrownCount: m.thrownCount,
      soslCount: m.soslCount,
      soslRows: m.soslRows,
    })),
    ...omitEmpty({ recommendations: generateRecommendations(msMethods) }),
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

/**
 * Advice for the worst few methods, in the form the caller cannot derive from the
 * table: which lever to pull. The figure that triggered each one is already a
 * column on the method's row, so it is not repeated here.
 *
 * An empty list means nothing stood out, which is what omitting the field says.
 */
function generateRecommendations(methods: SlowMethod[]): string[] {
  return methods
    .slice(0, 3)
    .map(getRecommendation)
    .filter((recommendation): recommendation is string => recommendation !== null);
}

function getRecommendation(method: SlowMethod): string | null {
  if (method.selfPercentage > 10 && method.selfDuration > 0.1) {
    return `${method.name}: dominates self time. Check whether it can be made faster, and how often it is called.`;
  }
  if (method.soqlRows > 1000) {
    return `${method.name}: high SOQL row count. Add WHERE clauses or paginate.`;
  }
  if (method.soqlCount > 5) {
    return `${method.name}: many SOQL queries. Bulkify or cache.`;
  }
  if (method.dmlCount > 3) {
    return `${method.name}: many DML operations. Bulkify them.`;
  }
  if (method.soslCount > 3) {
    return `${method.name}: many SOSL searches. Reduce or cache them.`;
  }

  return null;
}
