#!/usr/bin/env node

/**
 * LANA MCP Server - Model Context Protocol server for Apex Log Analysis
 *
 * This server provides tools for analyzing Salesforce Apex debug logs,
 * specifically focused on identifying performance bottlenecks and slow methods.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { ApexLog, LogLine, parse } from './ApexLogParser.js';

// Define argument types for better type safety
interface AnalyzeLogArgs {
  logFilePath: string;
  topMethods?: number;
  minDuration?: number;
  namespace?: string;
}

interface LogSummaryArgs {
  logFilePath: string;
}

interface BottleneckArgs {
  logFilePath: string;
  analysisType?: 'cpu' | 'database' | 'methods' | 'all';
}

interface SlowMethod {
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

interface LogAnalysisResult {
  totalMethods: number;
  totalExecutionTime: number;
  slowestMethods: SlowMethod[];
  summary: string;
  recommendations: string[];
}

class LanaServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'lana-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      // eslint-disable-next-line no-console
      console.error('[MCP Error]', error);
    };
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
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
        },
        {
          name: 'get_apex_log_summary',
          description:
            'Get a high-level summary of an Apex debug log including total execution time, method count, and governor limits',
          inputSchema: {
            type: 'object',
            properties: {
              logFilePath: {
                type: 'string',
                description: 'Absolute path to the Apex debug log file (.log)',
              },
            },
            required: ['logFilePath'],
          },
        },
        {
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
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'analyze_apex_log_performance':
            return await this.analyzeLogPerformance(args as unknown as AnalyzeLogArgs);
          case 'get_apex_log_summary':
            return await this.getLogSummary(args as unknown as LogSummaryArgs);
          case 'find_performance_bottlenecks':
            return await this.findPerformanceBottlenecks(args as unknown as BottleneckArgs);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async analyzeLogPerformance(args: AnalyzeLogArgs) {
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
    const methods = this.extractMethods(apexLog, minDuration, namespace);

    // Sort by total duration (descending)
    methods.sort((a, b) => b.duration - a.duration);

    // Take top N methods
    const slowestMethods = methods.slice(0, topMethods);

    const result: LogAnalysisResult = {
      totalMethods: methods.length,
      totalExecutionTime: apexLog.duration.total,
      slowestMethods,
      summary: this.generatePerformanceSummary(slowestMethods, apexLog.duration.total),
      recommendations: this.generateRecommendations(slowestMethods),
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

  private async getLogSummary(args: LogSummaryArgs) {
    const { logFilePath } = args;

    try {
      await fs.access(logFilePath);
    } catch {
      throw new Error(`Log file not found: ${logFilePath}`);
    }

    const logContent = await fs.readFile(logFilePath, 'utf-8');
    const apexLog = parse(logContent);

    const summary = {
      file: path.basename(logFilePath),
      totalExecutionTime: apexLog.duration.total,
      totalMethods: this.countMethods(apexLog),
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
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async findPerformanceBottlenecks(args: BottleneckArgs) {
    const { logFilePath, analysisType = 'all' } = args;

    try {
      await fs.access(logFilePath);
    } catch {
      throw new Error(`Log file not found: ${logFilePath}`);
    }

    const logContent = await fs.readFile(logFilePath, 'utf-8');
    const apexLog = parse(logContent);

    interface BottleneckResult {
      cpuBottlenecks?: Record<string, unknown>;
      databaseBottlenecks?: Record<string, unknown>;
      methodBottlenecks?: Record<string, unknown>;
      governorLimitWarnings: Record<string, unknown>;
    }

    const bottlenecks: BottleneckResult = {
      governorLimitWarnings: this.analyzeGovernorLimits(apexLog),
    };

    if (analysisType === 'cpu' || analysisType === 'all') {
      bottlenecks.cpuBottlenecks = this.analyzeCPUBottlenecks(apexLog);
    }

    if (analysisType === 'database' || analysisType === 'all') {
      bottlenecks.databaseBottlenecks = this.analyzeDatabaseBottlenecks(apexLog);
    }

    if (analysisType === 'methods' || analysisType === 'all') {
      bottlenecks.methodBottlenecks = this.analyzeMethodBottlenecks(apexLog);
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

  private extractMethods(
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

  private countMethods(apexLog: ApexLog): number {
    let count = 0;
    const traverse = (node: LogLine) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (node.type === 'METHOD_ENTRY' || (node as any).subCategory === 'Method') {
        count++;
      }
      if (node.children) {
        node.children.forEach((child: LogLine) => traverse(child));
      }
    };
    traverse(apexLog);
    return count;
  }

  private generatePerformanceSummary(methods: SlowMethod[], totalTime: number): string {
    if (methods.length === 0) {
      return 'No methods found matching the criteria.';
    }

    const slowestMethod = methods[0];
    const totalSlowMethodsTime = methods.reduce((sum, method) => sum + method.duration, 0);
    const percentageOfTotal = totalTime > 0 ? (totalSlowMethodsTime / totalTime) * 100 : 0;

    return `Analysis found ${methods.length} methods. The slowest method "${slowestMethod.name}" took ${(slowestMethod.duration / 1000000).toFixed(2)}ms (${slowestMethod.percentage.toFixed(1)}% of total execution time). The top ${methods.length} methods account for ${percentageOfTotal.toFixed(1)}% of total execution time.`;
  }

  private generateRecommendations(methods: SlowMethod[]): string[] {
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

  private analyzeCPUBottlenecks(apexLog: ApexLog): Record<string, unknown> {
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

  private analyzeDatabaseBottlenecks(apexLog: ApexLog): Record<string, unknown> {
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

  private analyzeMethodBottlenecks(apexLog: ApexLog): Record<string, unknown> {
    const methods = this.extractMethods(apexLog, 0);
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

  private analyzeGovernorLimits(apexLog: ApexLog): Record<string, unknown> {
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

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // eslint-disable-next-line no-console
    console.error('LANA MCP Server running on stdio');
  }
}

const server = new LanaServer();
// eslint-disable-next-line no-console
server.run().catch(console.error);
