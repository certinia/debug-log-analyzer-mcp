/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { isAbsolute } from "path";
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
