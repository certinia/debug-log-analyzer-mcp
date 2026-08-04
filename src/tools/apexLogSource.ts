/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";
import {
  parse,
  ApexLog,
  LogLine,
  type LogSubCategory,
} from "../ApexLogParser.js";

type CachedLog = {
  path: string;
  fingerprint: string;
  log: Promise<ApexLog>;
};

/**
 * Everything `fs.stat` can say about which bytes are at this path.
 *
 * Size and modification time alone are not enough: `cp -p` puts a different
 * file here and keeps both of them. The change time closes that, because POSIX
 * moves `ctime` on any change to the inode and no copy tool can hold it back.
 * The inode number closes a rename over the path. Both are read from the same
 * `fs.stat` the cache already makes, so neither costs a further read.
 *
 * Nanoseconds rather than milliseconds, so two writes inside one millisecond
 * are still two fingerprints. This is not a guarantee — only the content is
 * that — but what it leaves is a file rewritten in place, to the same length,
 * inside one nanosecond.
 */
function fingerprintOf(stats: BigIntStats): string {
  return `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/**
 * The last parse, kept so that the usual "summary, then go deeper" flow parses
 * a large log once instead of once per tool. One slot only: the flow works
 * through a single log at a time, and a parsed 19 MB log is too big to hold
 * several of.
 *
 * This is not protocol state, so it holds under a stateless MCP revision. It is
 * a memo of a pure function of a file on disk, re-checked against `fs.stat` on
 * every call, and `logFilePath` is already the explicit handle the MCP
 * "Stateful Tools" guidance asks a tool to take. No request depends on an
 * earlier one: drop the slot and every response is the same.
 */
let cached: CachedLog | undefined;

/**
 * How long the slot survives after its last use. A parsed log holds four to
 * five times the size of the file, so a 200 MB log holds about a gigabyte.
 * That is worth holding while an agent works through one log, and not worth
 * holding until the process exits.
 */
const IDLE_EVICTION_MS = 5 * 60_000;

let evictionTimer: NodeJS.Timeout | undefined;

function scheduleEviction(): void {
  clearTimeout(evictionTimer);
  // unref, so a waiting timer never keeps an otherwise idle server alive.
  evictionTimer = setTimeout(clearApexLogCache, IDLE_EVICTION_MS).unref();
}

/**
 * Read and parse the log, reusing the last parse when the same file is asked
 * for again and nothing `fs.stat` can see about it has changed.
 */
export async function loadApexLog(logFilePath: string): Promise<ApexLog> {
  let stats;
  try {
    stats = await fs.stat(logFilePath, { bigint: true });
  } catch {
    throw new Error(`Log file not found: ${logFilePath}`);
  }

  const fingerprint = fingerprintOf(stats);
  if (
    cached &&
    cached.path === logFilePath &&
    cached.fingerprint === fingerprint
  ) {
    scheduleEviction();
    return cached.log;
  }

  // Hold the parse while it runs, not after it finishes, so a caller that
  // arrives while a large log is still being read shares that read instead of
  // starting its own. The slot is filled in the same microtask as the miss
  // above, so a second caller cannot slip between the two.
  const pending = fs.readFile(logFilePath, "utf-8").then(parse);
  cached = { path: logFilePath, fingerprint, log: pending };
  scheduleEviction();

  // A read or parse that failed must not be served to the next caller.
  pending.catch(() => {
    if (cached?.log === pending) {
      clearApexLogCache();
    }
  });

  return pending;
}

/** Drop the cached parse. Called on the idle timer, and by tests. */
export function clearApexLogCache(): void {
  clearTimeout(evictionTimer);
  evictionTimer = undefined;
  cached = undefined;
}

/**
 * The units the tools count and rank: entry points and the methods below them.
 * Every tool uses this one test, so their method totals agree.
 */
export function isMethodNode(node: LogLine): boolean {
  // subCategory is declared on TimedNode, a subclass, so it is read off the
  // node rather than tested with instanceof.
  const { subCategory } = node as LogLine & { subCategory?: LogSubCategory };
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
