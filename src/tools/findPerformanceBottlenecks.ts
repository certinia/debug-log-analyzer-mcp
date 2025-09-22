import { promises as fs } from 'fs';
import { parse, ApexLog, LogLine } from '../ApexLogParser.js';
import { SlowMethod, extractMethods } from './analyzeLogPerformance.js';

export interface BottleneckArgs {
  logFilePath: string;
  analysisType?: 'cpu' | 'database' | 'methods' | 'all';
}

interface BottleneckResult {
  cpuBottlenecks?: Record<string, unknown>;
  databaseBottlenecks?: Record<string, unknown>;
  methodBottlenecks?: Record<string, unknown>;
  governorLimitWarnings: Record<string, unknown>;
}

export const findPerformanceBottlenecksTool = {
  name: 'find_performance_bottlenecks',
  description:
    'Identify performance bottlenecks in an Apex log by analyzing CPU time, database operations, and method execution patterns',
  inputSchema: {
    type: 'object',
    properties: {
      logFilePath: {
        type: 'string',
        description: 'Absolute path to the Apex debug log file (.log)',
      },
      analysisType: {
        type: 'string',
        enum: ['cpu', 'database', 'methods', 'all'],
        description: 'Type of bottleneck analysis to perform',
        default: 'all',
      },
    },
    required: ['logFilePath'],
  },
};

export async function findPerformanceBottlenecks(args: BottleneckArgs) {
  const { logFilePath, analysisType = 'all' } = args;

  try {
    await fs.access(logFilePath);
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  const logContent = await fs.readFile(logFilePath, 'utf-8');
  const apexLog = parse(logContent);

  const bottlenecks: BottleneckResult = {
    governorLimitWarnings: analyzeGovernorLimits(apexLog),
  };

  if (analysisType === 'cpu' || analysisType === 'all') {
    bottlenecks.cpuBottlenecks = analyzeCPUBottlenecks(apexLog);
  }

  if (analysisType === 'database' || analysisType === 'all') {
    bottlenecks.databaseBottlenecks = analyzeDatabaseBottlenecks(apexLog);
  }

  if (analysisType === 'methods' || analysisType === 'all') {
    bottlenecks.methodBottlenecks = analyzeMethodBottlenecks(apexLog);
  }

  return {
    content: [
      {
        type: 'text',
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

  return {
    cpuTimeUsed: governorLimits.cpuTime.used,
    cpuTimeLimit: governorLimits.cpuTime.limit,
    cpuUsagePercentage: cpuUsagePercent,
    warning:
      cpuUsagePercent > 80 ? 'High CPU usage detected - consider optimizing algorithms' : null,
  };
}

function analyzeDatabaseBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const governorLimits = apexLog.governorLimits;
  return {
    soqlQueries: {
      used: governorLimits.soqlQueries.used,
      limit: governorLimits.soqlQueries.limit,
      percentage:
        governorLimits.soqlQueries.limit > 0
          ? (governorLimits.soqlQueries.used / governorLimits.soqlQueries.limit) * 100
          : 0,
    },
    dmlStatements: {
      used: governorLimits.dmlStatements.used,
      limit: governorLimits.dmlStatements.limit,
      percentage:
        governorLimits.dmlStatements.limit > 0
          ? (governorLimits.dmlStatements.used / governorLimits.dmlStatements.limit) * 100
          : 0,
    },
    queryRows: {
      used: governorLimits.queryRows.used,
      limit: governorLimits.queryRows.limit,
      percentage:
        governorLimits.queryRows.limit > 0
          ? (governorLimits.queryRows.used / governorLimits.queryRows.limit) * 100
          : 0,
    },
  };
}

function analyzeMethodBottlenecks(apexLog: ApexLog): Record<string, unknown> {
  const methods = extractMethods(apexLog, 0);
  const methodsByNamespace = methods.reduce((acc: Record<string, SlowMethod[]>, method) => {
    if (!acc[method.namespace]) {
      acc[method.namespace] = [];
    }
    acc[method.namespace].push(method);
    return acc;
  }, {});

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.entries(limits).forEach(([key, value]: [string, any]) => {
    if (key !== 'byNamespace' && value.limit > 0) {
      const percentage = (value.used / value.limit) * 100;
      if (percentage > 80) {
        warnings.push(
          `${key}: ${percentage.toFixed(1)}% of limit used (${value.used}/${value.limit})`,
        );
      }
    }
  });

  return {
    warnings,
    details: limits,
  };
}