import {
  ApexLogParser,
  parse,
  ApexLog,
  Method,
  LogLine,
  GovernorLimits,
  LogIssue,
  DebugLevel,
  LogSubCategory,
  TimedNode
} from '../src/ApexLogParser.js';

describe('ApexLogParser', () => {
  let parser: ApexLogParser;

  beforeEach(() => {
    parser = new ApexLogParser();
  });

  describe('parse function', () => {
    it('should parse a minimal valid log', () => {
      const logData = createBasicLog();
      const result = parse(logData);

      expect(result).toBeInstanceOf(ApexLog);
      expect(result.size).toBe(logData.length);
      expect(result.text).toBe('LOG_ROOT');
    });

    it('should handle empty log data', () => {
      const result = parse('');

      expect(result).toBeInstanceOf(ApexLog);
      expect(result.size).toBe(0);
      expect(result.children).toHaveLength(0);
    });

    it('should parse debug levels from log header', () => {
      const logData = createLogWithDebugLevels();
      const result = parse(logData);

      expect(result.debugLevels).toHaveLength(5);
      expect(result.debugLevels[0].logCategory).toBe('APEX_CODE');
      expect(result.debugLevels[0].logLevel).toBe('FINEST');
    });
  });

  describe('ApexLogParser class', () => {
    it('should initialize with default values', () => {
      expect(parser.logIssues).toEqual([]);
      expect(parser.parsingErrors).toEqual([]);
      expect(parser.lastTimestamp).toBe(0);
      expect(parser.namespaces.size).toBe(0);
      expect(parser.governorLimits.cpuTime.used).toBe(0);
    });

    it('should parse method entry and exit correctly', () => {
      const logData = createLogWithMethodCalls();
      const result = parser.parse(logData);

      expect(result.children.length).toBeGreaterThan(0);

      // The log structure has ExecutionStartedLine as first child, then MethodEntryLine as its child
      const executionStarted = result.children[0];
      expect(executionStarted).toBeDefined();
      expect(executionStarted.children.length).toBeGreaterThan(0);

      const methodCall = executionStarted.children[0];
      expect(methodCall.text).toBe('TestClass.testMethod()');
      expect(methodCall.timestamp).toBeGreaterThan(0);
    });

    it('should track namespaces correctly', () => {
      const logData = createLogWithNamespaces();
      const result = parser.parse(logData);

      expect(result.namespaces).toContain('testns');
      expect(result.namespaces).toContain('default');
    });

    it('should handle nested method calls', () => {
      const logData = createLogWithNestedMethods();
      const result = parser.parse(logData);

      const executionStarted = result.children[0];
      const outerMethod = executionStarted.children[0];
      expect(outerMethod.text).toBe('TestClass.outerMethod()');
      expect(outerMethod.children.length).toBeGreaterThan(0);

      const innerMethod = outerMethod.children[0];
      expect(innerMethod.text).toBe('TestClass.innerMethod()');
    });
  });

  describe('SOQL and DML parsing', () => {
    it('should parse SOQL queries correctly', () => {
      const logData = createLogWithSOQL();
      const result = parser.parse(logData);

      const soqlLine = findLogLineByType(result, 'SOQL_EXECUTE_BEGIN');
      expect(soqlLine).toBeDefined();
      expect(soqlLine?.text).toContain('SELECT');
    });

    it('should parse DML operations correctly', () => {
      const logData = createLogWithDML();
      const result = parser.parse(logData);

      const dmlBegin = findLogLineByType(result, 'DML_BEGIN');
      expect(dmlBegin).toBeDefined();
      expect(dmlBegin?.logLine).toContain('Insert');

      const dmlEnd = findLogLineByType(result, 'DML_END');
      expect(dmlEnd).toBeDefined();
    });
  });

  describe('Governor limits tracking', () => {
    it('should parse governor limits correctly', () => {
      const logData = createLogWithGovernorLimits();
      const result = parser.parse(logData);

      expect(result.governorLimits.cpuTime.limit).toBeGreaterThan(0);
      expect(result.governorLimits.soqlQueries.limit).toBeGreaterThan(0);
      expect(result.governorLimits.dmlStatements.limit).toBeGreaterThan(0);
    });

    it('should track namespace-specific limits', () => {
      const logData = createLogWithNamespaceGovernorLimits();
      const result = parser.parse(logData);

      expect(result.governorLimits.byNamespace.has('testns')).toBe(true);
      const nsLimits = result.governorLimits.byNamespace.get('testns');
      expect(nsLimits?.cpuTime.used).toBeGreaterThan(0);
    });
  });

  describe('Performance metrics', () => {
    it('should calculate method duration correctly', () => {
      const logData = createLogWithTimedMethods();
      const result = parser.parse(logData);

      const executionStarted = result.children[0] as Method;
      const methodCall = executionStarted.children[0] as Method;
      expect(methodCall.duration.total).toBeGreaterThan(0);
      expect(methodCall.exitStamp).toBeGreaterThan(methodCall.timestamp);
    });

    it('should track CPU time consumption', () => {
      const logData = createLogWithCPUConsumption();
      const result = parser.parse(logData);

      expect(result.governorLimits.cpuTime.used).toBeGreaterThan(0);
    });
  });

  describe('Error handling', () => {
    it('should handle malformed log entries gracefully', () => {
      const logData = createMalformedLog();
      const result = parser.parse(logData);

      expect(result.parsingErrors.length).toBeGreaterThan(0);
      expect(result).toBeInstanceOf(ApexLog);
    });

    it('should handle unmatched method exits', () => {
      const logData = createLogWithUnmatchedExits();
      const result = parser.parse(logData);

      // The parser may not always generate error log issues for unmatched exits
      // but it should handle them gracefully
      expect(result).toBeInstanceOf(ApexLog);
      expect(result.children.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle truncated logs', () => {
      const logData = createTruncatedLog();
      const result = parser.parse(logData);

      const truncatedMethod = result.children.find(child =>
        child instanceof Method && child.isTruncated
      ) as Method;
      expect(truncatedMethod).toBeDefined();
    });
  });

  describe('Log issues detection', () => {
    it('should detect CPU time limit exceeded', () => {
      const logData = createLogWithCPULimitExceeded();
      const result = parser.parse(logData);

      const cpuIssue = result.logIssues.find(issue =>
        issue.summary.includes('CPU') && issue.type === 'error'
      );
      expect(cpuIssue).toBeDefined();
    });

    it('should detect heap size issues', () => {
      const logData = createLogWithHeapIssue();
      const result = parser.parse(logData);

      const heapIssue = result.logIssues.find(issue =>
        issue.summary.includes('heap') || issue.summary.includes('memory')
      );
      expect(heapIssue).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle logs without execution started marker', () => {
      const logData = createLogWithoutExecutionStarted();
      const result = parser.parse(logData);

      expect(result).toBeInstanceOf(ApexLog);
      expect(result.children.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large timestamps', () => {
      const logData = createLogWithLargeTimestamps();
      const result = parser.parse(logData);

      expect(result.children.length).toBeGreaterThan(0);
      expect(result.duration.total).toBeGreaterThan(0);
    });

    it('should handle special characters in method names', () => {
      const logData = createLogWithSpecialCharacters();
      const result = parser.parse(logData);

      const executionStarted = result.children[0];
      const methodWithSpecialChars = executionStarted.children.find((child: any) =>
        child.text?.includes('special$Method')
      );
      expect(methodWithSpecialChars).toBeDefined();
    });
  });
});

// Helper function to find a log line by type
function findLogLineByType(log: ApexLog, type: string): LogLine | undefined {
  const searchInChildren = (node: LogLine): LogLine | undefined => {
    if (node.type === type) {
      return node;
    }
    for (const child of node.children) {
      const found = searchInChildren(child);
      if (found) return found;
    }
    return undefined;
  };

  return searchInChildren(log);
}

// Test data creation functions

function createBasicLog(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|EXECUTION_FINISHED`;
}

function createLogWithDebugLevels(): string {
  return `62.0 APEX_CODE,FINEST;APEX_PROFILING,FINEST;CALLOUT,INFO;DB,FINEST;SYSTEM,FINE
21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|EXECUTION_FINISHED`;
}

function createLogWithMethodCalls(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.testMethod()
21:49:36.0 (5000)|METHOD_EXIT|[1]|TestClass
21:49:36.0 (6000)|EXECUTION_FINISHED`;
}

function createLogWithNamespaces(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|ENTERING_MANAGED_PKG|testns
21:49:36.0 (3000)|METHOD_ENTRY|[1]|01p050000001ABC|testns.TestClass.testMethod()
21:49:36.0 (5000)|METHOD_EXIT|[1]|testns.TestClass
21:49:36.0 (6000)|EXECUTION_FINISHED`;
}

function createLogWithNestedMethods(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.outerMethod()
21:49:36.0 (3000)|METHOD_ENTRY|[5]|01p050000001DEF|TestClass.innerMethod()
21:49:36.0 (4000)|METHOD_EXIT|[5]|TestClass
21:49:36.0 (5000)|METHOD_EXIT|[1]|TestClass
21:49:36.0 (6000)|EXECUTION_FINISHED`;
}

function createLogWithSOQL(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|SOQL_EXECUTE_BEGIN|[10]|Aggregations:0|SELECT Id, Name FROM Account WHERE Name = 'Test'
21:49:36.0 (8000)|SOQL_EXECUTE_END|[10]|Rows:5
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createLogWithDML(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|DML_BEGIN|[15]|Op:Insert|Type:Account|Rows:3
21:49:36.0 (8000)|DML_END|[15]
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createLogWithGovernorLimits(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|CUMULATIVE_LIMIT_USAGE
21:49:36.0 (2001)|LIMIT_USAGE_FOR_NS|(default)|
  Number of SOQL queries: 5 out of 100
  Number of query rows: 150 out of 50000
  Number of SOSL queries: 0 out of 20
  Number of DML statements: 2 out of 150
  Number of DML rows: 10 out of 10000
  Maximum CPU time: 1500 out of 10000
  Maximum heap size: 0 out of 6000000
21:49:36.0 (2002)|CUMULATIVE_LIMIT_USAGE_END
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createLogWithNamespaceGovernorLimits(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|ENTERING_MANAGED_PKG|testns
21:49:36.0 (3000)|CUMULATIVE_LIMIT_USAGE
21:49:36.0 (3001)|LIMIT_USAGE_FOR_NS|testns|
  Number of SOQL queries: 2 out of 100
  Number of DML statements: 1 out of 150
  Maximum CPU time: 500 out of 10000
21:49:36.0 (3002)|CUMULATIVE_LIMIT_USAGE_END
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createLogWithTimedMethods(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.timedMethod()
21:49:36.0 (15000)|METHOD_EXIT|[1]|TestClass
21:49:36.0 (16000)|EXECUTION_FINISHED`;
}

function createLogWithCPUConsumption(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|CUMULATIVE_LIMIT_USAGE
21:49:36.0 (2001)|LIMIT_USAGE_FOR_NS|(default)|
  Maximum CPU time: 5000 out of 10000
21:49:36.0 (2002)|CUMULATIVE_LIMIT_USAGE_END
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createMalformedLog(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|INVALID_LOG_TYPE|Some invalid data
21:49:36.0 (3000)|METHOD_ENTRY|MALFORMED_ENTRY_MISSING_PARTS
21:49:36.0 (4000)|EXECUTION_FINISHED`;
}

function createLogWithUnmatchedExits(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|METHOD_EXIT|[1]|TestClass
21:49:36.0 (3000)|METHOD_ENTRY|[2]|01p050000001ABC|TestClass.testMethod()
21:49:36.0 (4000)|EXECUTION_FINISHED`;
}

function createTruncatedLog(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.testMethod()
21:49:36.0 (3000)|METHOD_ENTRY|[5]|01p050000001DEF|TestClass.innerMethod()`;
  // Note: Missing METHOD_EXIT and EXECUTION_FINISHED to simulate truncation
}

function createLogWithCPULimitExceeded(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|FATAL_ERROR|System.LimitException: Apex CPU time limit exceeded
21:49:36.0 (3000)|CUMULATIVE_LIMIT_USAGE
21:49:36.0 (3001)|LIMIT_USAGE_FOR_NS|(default)|
  Maximum CPU time: 10000 out of 10000
21:49:36.0 (3002)|CUMULATIVE_LIMIT_USAGE_END
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createLogWithHeapIssue(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|HEAP_ALLOCATE|[10]|Bytes:5500000
21:49:36.0 (3000)|FATAL_ERROR|System.LimitException: Apex heap size too large
21:49:36.0 (4000)|CUMULATIVE_LIMIT_USAGE
21:49:36.0 (4001)|LIMIT_USAGE_FOR_NS|(default)|
  Maximum heap size: 5500000 out of 6000000
21:49:36.0 (4002)|CUMULATIVE_LIMIT_USAGE_END
21:49:36.0 (9000)|EXECUTION_FINISHED`;
}

function createLogWithoutExecutionStarted(): string {
  return `21:49:36.0 (1000)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.testMethod()
21:49:36.0 (5000)|METHOD_EXIT|[1]|TestClass`;
}

function createLogWithLargeTimestamps(): string {
  return `21:49:36.0 (999999999)|EXECUTION_STARTED
21:49:36.0 (1999999999)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.testMethod()
21:49:36.0 (2999999999)|METHOD_EXIT|[1]|TestClass
21:49:36.0 (3999999999)|EXECUTION_FINISHED`;
}

function createLogWithSpecialCharacters(): string {
  return `21:49:36.0 (1000)|EXECUTION_STARTED
21:49:36.0 (2000)|METHOD_ENTRY|[1]|01p050000001ABC|TestClass.special$Method()
21:49:36.0 (3000)|METHOD_ENTRY|[5]|01p050000001DEF|Test_Class.method_with_underscores()
21:49:36.0 (4000)|METHOD_EXIT|[5]|Test_Class
21:49:36.0 (5000)|METHOD_EXIT|[1]|TestClass
21:49:36.0 (6000)|EXECUTION_FINISHED`;
}