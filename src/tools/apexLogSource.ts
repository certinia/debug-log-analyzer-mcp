/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs, type BigIntStats } from "fs";
import { isAbsolute } from "path";
import { z } from "zod";
import {
  parse,
  ApexLog,
  LogLine,
} from "../ApexLogParser.js";

/**
 * The one declaration of the log path, shared by every tool that takes one, so
 * all three enforce it the same way.
 *
 * A relative path is refused rather than resolved: it would resolve against the
 * server's working directory, which is where the client happened to spawn us
 * and not where the caller is. Resolving would read a different file, or none,
 * and report neither. Refinements do not reach the JSON schema, so this costs
 * no tokens in the tool definition — `pnpm run eval` holds that to its budget.
 */
export const logFilePathSchema = z
  .string()
  .refine(isAbsolute, "must be an absolute path")
  .describe("Absolute path to the Apex debug log file (.log)");

type CachedLog = {
  path: string;
  fingerprint: string;
  log: Promise<ApexLog>;
};

/**
 * Everything a stat can say about which bytes these are.
 *
 * Size and modification time alone are not enough: `cp -p` puts a different
 * file here and keeps both of them. The change time closes that, because POSIX
 * moves `ctime` on any change to the inode and no copy tool can hold it back.
 * The inode number closes a rename over the path. Both are read from the stat
 * the cache already makes, so neither costs a further read.
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
 * for again and nothing a stat can see about it has changed.
 */
export async function loadApexLog(logFilePath: string): Promise<ApexLog> {
  // Open the file once, and stat and read that one handle. A stat of the path
  // and then a read of the path can touch two different files, if something
  // replaces the path between them: the fingerprint would belong to the old
  // file and the bytes to the new one. A handle holds one inode, so the
  // fingerprint below describes exactly the bytes this call goes on to read.
  let handle;
  let fingerprint;
  try {
    handle = await fs.open(logFilePath, "r");
    fingerprint = fingerprintOf(await handle.stat({ bigint: true }));
  } catch (error) {
    await handle?.close();
    // A missing file is one of several ways this fails. Reporting all of them
    // as "not found" sends the caller to look for a file that is there, when
    // the real cause was a permission, a directory in place of a file, or a
    // full descriptor table. Name the cause, and keep the original as `cause`.
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    const message =
      code === "ENOENT"
        ? `Log file not found: ${logFilePath}`
        : `Cannot read log file ${logFilePath}: ${code}`;
    throw new Error(message, { cause: error });
  }

  try {
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
    const pending = handle.readFile("utf-8").then(parse);
    cached = { path: logFilePath, fingerprint, log: pending };
    scheduleEviction();

    // A read or parse that failed must not be served to the next caller.
    pending.catch(() => {
      if (cached?.log === pending) {
        clearApexLogCache();
      }
    });

    return await pending;
  } finally {
    await handle.close();
  }
}

/** Drop the cached parse. Called on the idle timer, and by tests. */
export function clearApexLogCache(): void {
  clearTimeout(evictionTimer);
  evictionTimer = undefined;
  cached = undefined;
}

/**
 * Visit the node and every node below it, parents first.
 *
 * What `visit` returns is passed to that node's children, so a visitor can carry
 * what encloses a node down to it without a second pass.
 */
export function walkLog<T>(
  node: LogLine,
  visit: (node: LogLine, inherited: T | undefined) => T,
  inherited?: T,
): void {
  const next = visit(node, inherited);
  node.children?.forEach((child) => walkLog(child, visit, next));
}
