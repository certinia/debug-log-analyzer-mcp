/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * The one module that imports `@apexdevtools/apex-log-parser`; a lint rule
 * refuses it anywhere else. A parser change then touches this module and the
 * fields the tools read, and no import beyond it.
 *
 * The tools still read the parser's own events and types, under the parser's
 * names: a copy into types of our own would cost a pass over every event.
 */

export type {
  ApexLog,
  ApexLogParser,
  DebugCategory,
  DebugLevels,
  GovernorLimits,
  LimitMetricUnit,
  Limits,
  LineNumber,
  LogEvent,
  LogEventType,
  LogIssue,
  NamespaceLimits,
  SOQLExecuteExplainLine,
} from "@apexdevtools/apex-log-parser";
export { ALL_LIMIT_METRICS, LOG_LEVEL } from "@apexdevtools/apex-log-parser";

export { clearApexLogCache, loadApexLog, walkLog } from "./source.js";
