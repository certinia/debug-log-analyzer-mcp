/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "fs";
import { parse, ApexLog, LogLine } from "../ApexLogParser.js";

type CachedLog = {
  path: string;
  mtimeMs: number;
  size: number;
  log: ApexLog;
};

/**
 * The last parse, kept so that the usual "summary, then go deeper" flow parses
 * a large log once instead of once per tool. One slot only: the flow works
 * through a single log at a time, and a parsed 19 MB log is too big to hold
 * several of.
 */
let cached: CachedLog | undefined;

/**
 * Read and parse the log, reusing the last parse when the same file is asked
 * for again and neither its size nor its modification time has changed.
 */
export async function loadApexLog(logFilePath: string): Promise<ApexLog> {
  let stats;
  try {
    stats = await fs.stat(logFilePath);
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  if (
    cached &&
    cached.path === logFilePath &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size
  ) {
    return cached.log;
  }

  const log = parse(await fs.readFile(logFilePath, "utf-8"));
  cached = {
    path: logFilePath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    log,
  };
  return log;
}

/** Drop the cached parse. For tests, which write a new log to the same path. */
export function clearApexLogCache(): void {
  cached = undefined;
}

/**
 * The units the tools count and rank: entry points and the methods below them.
 * Every tool uses this one test, so their method totals agree.
 */
export function isMethodNode(node: LogLine): boolean {
  // subCategory is declared on TimedNode, a subclass, so it is read off the
  // node rather than tested with instanceof.
  const { subCategory } = node as LogLine & { subCategory?: string };
  return (
    node.type === "CODE_UNIT_STARTED" ||
    node.type === "METHOD_ENTRY" ||
    subCategory === "Method"
  );
}

/** Visit the node and every node below it, parents first. */
export function walkLog(node: LogLine, visit: (node: LogLine) => void): void {
  visit(node);
  node.children?.forEach((child) => walkLog(child, visit));
}
