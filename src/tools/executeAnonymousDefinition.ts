/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What `tools/list` puts on the wire for `apexlog_execute_anonymous`, apart
 * from the handler, so registration stays synchronous while `src/server.ts`
 * loads the handler lazily. The analysis tools need no such module: nothing
 * they import is expensive. The other org tools have their own `*Definition.ts`.
 *
 * This module must never import `./executeAnonymous.js`, which would put the
 * Salesforce SDK back in the startup graph.
 */

import { z } from "zod";
import {
  DEFAULT_TRACE_CONFIG,
  levelsClause,
  LOG_LEVELS,
} from "../logLevels.js";
import { describeDisabled } from "../policy/orgExecutionPolicy.js";
import {
  levelsByCategorySchema,
  outputDirSchema,
  targetOrgSchema,
  toolInputSchema,
} from "./inputSchema.js";
import { absolutePathSchema } from "./localFile.js";

export const executeAnonymousInputSchema = {
  apex: z
    .string()
    .optional()
    .describe("The anonymous Apex to execute, or use apexFilePath"),
  apexFilePath: absolutePathSchema
    .optional()
    .describe("Absolute path to a file of anonymous Apex"),
  targetOrg: targetOrgSchema,
  outputDir: outputDirSchema,
  // The schemas already list the levels and the categories, so the description
  // says only what they cannot: what each form does, and the per-category
  // defaults, read from `DEFAULT_TRACE_CONFIG` so they cannot go stale.
  debugLevel: z
    .union([
      z.enum(["default", ...LOG_LEVELS]),
      levelsByCategorySchema,
    ])
    .optional()
    .describe(
      `This run's log levels. Omit for the user's trace flag levels, else the defaults; "default" forces the defaults; a bare level sets every category; an object sets the named categories over the defaults. Defaults: ${levelsClause(DEFAULT_TRACE_CONFIG)}.`,
    ),
};

export type ExecuteAnonymousArgs = z.infer<
  z.ZodObject<typeof executeAnonymousInputSchema>
>;

const EXECUTE_ANONYMOUS_DESCRIPTION =
  "Execute anonymous Apex in a Salesforce org as the targetOrg user; DML commits unless the run fails. Saves the debug log and returns its path for the analysis tools. With no active trace flag, adds one for the run, deleted after, and a debug level, left in the org.";

/**
 * The tool is always registered so that agents can discover it. `refusal` is
 * what this server answers every call, or undefined when it runs Apex.
 */
export function executeAnonymousTool(refusal?: string) {
  return {
    name: "apexlog_execute_anonymous",
    config: {
      title: "Execute Anonymous Apex",
      description: describeDisabled(EXECUTE_ANONYMOUS_DESCRIPTION, refusal),
      inputSchema: toolInputSchema(executeAnonymousInputSchema),
      // All four hints, where the read-only tools state only the two that differ
      // from the spec default: this is the one tool where a client that misreads a
      // default runs Apex against an org.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    refusal,
  };
}
