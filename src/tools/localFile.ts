/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { promises as fs } from "node:fs";
import path, { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * The one declaration of a file path a tool reads, so every tool enforces it
 * the same way.
 *
 * A relative path is refused rather than resolved: it would resolve against the
 * server's working directory, which is where the client happened to spawn us
 * and not where the caller is. Resolving would read a different file, or none,
 * and report neither. Refinements do not reach the JSON schema, so this costs
 * no tokens in the tool definition - `pnpm run eval` holds that to its budget.
 */
export const absolutePathSchema = z
  .string()
  .refine(isAbsolute, "must be an absolute path");

/**
 * Why a file could not be read, by its errno. A missing file is one of several
 * ways this fails; reporting all of them as "not found" sends the caller to look
 * for a file that is there, when the cause was a permission, a directory in
 * place of a file, or a full descriptor table.
 *
 * `noun` names the file as a sentence would, e.g. "log file" or "Apex file".
 */
export function fileReadError(
  noun: string,
  filePath: string,
  error: unknown,
): Error {
  const code = (error as NodeJS.ErrnoException).code ?? String(error);
  const message =
    code === "ENOENT"
      ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not found: ${filePath}`
      : `Cannot read ${noun} ${filePath}: ${code}`;
  return new Error(message, { cause: error });
}

/** The resolved path, or the path itself when it does not resolve. */
async function realPathOrSelf(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

/**
 * `target` with symlinks followed when it is outside every root, else
 * undefined. No roots, no check. Symlinks are followed on both sides, so a link
 * inside a root that points out of one is still outside.
 */
export async function outsideRoots(
  target: string,
  rootPaths: string[],
): Promise<string | undefined> {
  if (rootPaths.length === 0) {
    return undefined;
  }

  const resolved = await realPathOrSelf(target);
  const roots = await Promise.all(rootPaths.map(realPathOrSelf));
  const inside = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  return inside ? undefined : resolved;
}
