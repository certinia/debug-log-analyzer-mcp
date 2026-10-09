/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Workspace } from "../salesforce/orgAccess.js";
import { outsideRoots } from "./localFile.js";

/** Where debug logs go when the caller names no `outputDir`, under the project root. */
const DEFAULT_OUTPUT_DIR = ".apex-log-mcp";

/** The directory every org tool saves debug logs to. */
export type LogStore = {
  /** Absolute, because a saved path goes straight to the analysis tools, which refuse a relative one. */
  dir: string;
  /** True when this call created it, so nothing yet ignores it. */
  created: boolean;
  /** Why the directory may be somewhere the caller did not expect, or undefined. */
  warning?: string;
};

function logWarning(warning: string): string {
  console.error(`[apex-log-mcp] ${warning}`);
  return warning;
}

/**
 * Resolve and create `outputDir`. A relative one anchors to the project root,
 * the same base the default uses, not to wherever the client spawned this
 * server.
 *
 * The MCP spec expects a server to work inside the roots the client declares,
 * and `outputDir` is agent-supplied, so it is the path an injected instruction
 * takes. Refusing would break a caller who means to write elsewhere, so the
 * response says so instead, and the same line goes to stderr for the person
 * watching the server.
 */
export async function openLogStore(
  outputDir: string | undefined,
  workspace: Workspace,
  rootPaths: string[],
): Promise<LogStore> {
  const dir = path.resolve(
    rootPaths[0] ?? process.cwd(),
    outputDir ?? DEFAULT_OUTPUT_DIR,
  );
  // Resolves to the first directory created, or undefined when it already existed.
  const created = Boolean(await fs.mkdir(dir, { recursive: true }));

  // Unusable roots leave even the default, in the cwd, unchecked; usable, the default is inside the first root.
  if (workspace.kind === "unknown") {
    const warning = `Debug log written to ${dir}, which was not checked against the client's roots: ${workspace.reason}.`;
    return { dir, created, warning: logWarning(warning) };
  }
  const outside =
    outputDir === undefined ? undefined : await outsideRoots(dir, rootPaths);
  return outside === undefined
    ? { dir, created }
    : {
        dir,
        created,
        warning: logWarning(
          `Debug log written to ${outside}, which is outside every root this client declared.`,
        ),
      };
}

/**
 * Write the log out, under the id Salesforce filed it as when there is one,
 * and never over a file already there: the id is matched rather than given, so
 * a wrong match must cost a filename and not an earlier run's log.
 */
export async function writeDebugLog(
  outputDir: string,
  logId: string | undefined,
  debugLog: string,
): Promise<string> {
  const fallbackPath = path.join(outputDir, `apex-${Date.now()}.log`);
  if (logId) {
    const filePath = path.join(outputDir, `${logId}.log`);
    // Whole, as `saveStoredLog` writes, and a link, not a rename, so a file already there stays.
    const partPath = partPathFor(filePath);
    await fs.writeFile(partPath, debugLog, "utf-8");
    try {
      await fs.link(partPath, filePath);
      return filePath;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      console.error(
        `[apex-log-mcp] ${filePath} already holds a log, so this run was written to ${fallbackPath} instead.`,
      );
    } finally {
      await fs.rm(partPath, { force: true });
    }
  }
  await fs.writeFile(fallbackPath, debugLog, "utf-8");
  return fallbackPath;
}

/** Where `saveStoredLog` put a log, and whether this call downloaded it. */
export type StoredLog = {
  filePath: string;
  fileSizeBytes: number;
  downloaded: boolean;
};

/**
 * Save a stored log under its id, unless it is saved there already: an
 * `ApexLog` never changes once stored, so the same id is the same text.
 */
export async function saveStoredLog(
  outputDir: string,
  logId: string,
  download: () => Promise<string>,
): Promise<StoredLog> {
  const filePath = path.join(outputDir, `${logId}.log`);
  const existing = await fs.stat(filePath).catch(() => undefined);
  if (existing?.isFile()) {
    return { filePath, fileSizeBytes: existing.size, downloaded: false };
  }
  const text = await download();
  // Whole or not at all, since any file under the id is taken as the log.
  const partPath = partPathFor(filePath);
  await fs.writeFile(partPath, text, "utf-8");
  await fs.rename(partPath, filePath);
  return {
    filePath,
    fileSizeBytes: Buffer.byteLength(text, "utf-8"),
    downloaded: true,
  };
}

// Unique per write, so two calls saving one id never share a temporary file.
function partPathFor(filePath: string): string {
  return `${filePath}.${randomUUID()}.part`;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
