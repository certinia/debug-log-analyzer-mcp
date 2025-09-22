import { promises as fs } from 'fs';
import { parse, ApexLog, LogLine } from '../ApexLogParser.js';

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
  percentage: number;
}

export interface LogAnalysisResult {
  totalMethods: number;
  totalExecutionTime: number;
  slowestMethods: SlowMethod[];
  summary: string;
  recommendations: string[];
}

export const analyzeLogPerformanceTool = {
  name: 'analyze_apex_log_performance',
  description:
    'Analyze an Apex debug log file and identify the slowest running methods with performance metrics',
  inputSchema: {
    type: 'object',
    properties: {
      logFilePath: {
        type: 'string',
        description: 'Absolute path to the Apex debug log file (.log)',
      },
      topMethods: {
        type: 'number',
        description: 'Number of slowest methods to return (default: 10)',
        default: 10,
      },
      minDuration: {
        type: 'number',
        description: 'Minimum duration in nanoseconds to include a method (default: 0)',
        default: 0,
      },
      namespace: {
        type: 'string',
        description: 'Filter methods by namespace (optional)',
      },
    },
    required: ['logFilePath'],
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
  const logContent = await fs.readFile(logFilePath, 'utf-8');
  const apexLog = parse(logContent);

  // Extract all methods with their performance data
  const methods = extractMethods(apexLog, minDuration, namespace);

  // Sort by total duration (descending)
  methods.sort((a, b) => b.duration - a.duration);

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
        type: 'text',
        text: JSON.stringify(result, null, 2),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (node.type === 'METHOD_ENTRY' || (node as any).subCategory === 'Method') {
      if (node.duration.total >= minDuration) {
        if (!namespaceFilter || node.namespace === namespaceFilter) {
          methods.push({
            name: node.text || 'Unknown Method',
            duration: node.duration.total,
            selfDuration: node.duration.self,
            namespace: node.namespace || 'default',
            lineNumber: node.lineNumber,
            dmlCount: node.dmlCount.total,
            soqlCount: node.soqlCount.total,
            dmlRows: node.dmlRowCount.total,
            soqlRows: node.soqlRowCount.total,
            percentage: totalTime > 0 ? (node.duration.total / totalTime) * 100 : 0,
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

function generatePerformanceSummary(methods: SlowMethod[], totalTime: number): string {
  if (methods.length === 0) {
    return 'No methods found matching the criteria.';
  }

  const slowestMethod = methods[0];
  const totalSlowMethodsTime = methods.reduce((sum, method) => sum + method.duration, 0);
  const percentageOfTotal = totalTime > 0 ? (totalSlowMethodsTime / totalTime) * 100 : 0;

  return `Analysis found ${methods.length} methods. The slowest method "${slowestMethod.name}" took ${(slowestMethod.duration / 1000000).toFixed(2)}ms (${slowestMethod.percentage.toFixed(1)}% of total execution time). The top ${methods.length} methods account for ${percentageOfTotal.toFixed(1)}% of total execution time.`;
}

function generateRecommendations(methods: SlowMethod[]): string[] {
  const recommendations: string[] = [];

  methods.forEach((method, index) => {
    if (index < 3) {
      // Focus on top 3 methods
      if (method.soqlCount > 5) {
        recommendations.push(
          `Method "${method.name}" executes ${method.soqlCount} SOQL queries. Consider reducing query count through bulkification or caching.`,
        );
      }
      if (method.dmlCount > 3) {
        recommendations.push(
          `Method "${method.name}" performs ${method.dmlCount} DML operations. Consider bulkifying DML operations.`,
        );
      }
      if (method.soqlRows > 1000) {
        recommendations.push(
          `Method "${method.name}" processes ${method.soqlRows} SOQL rows. Consider adding WHERE clauses or using pagination.`,
        );
      }
      if (method.percentage > 20) {
        recommendations.push(
          `Method "${method.name}" consumes ${method.percentage.toFixed(1)}% of total execution time. This should be a priority for optimization.`,
        );
      }
    }
  });

  if (recommendations.length === 0) {
    recommendations.push(
      'Performance looks good! No obvious bottlenecks detected in the analyzed methods.',
    );
  }

  return recommendations;
}