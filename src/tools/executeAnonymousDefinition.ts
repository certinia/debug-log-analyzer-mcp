/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What `tools/list` puts on the wire for `apexlog_execute_anonymous`, apart
 * from the handler, so registration stays synchronous while `src/server.ts`
 * loads the handler lazily. The other three tools need no such module: nothing
 * they import is expensive.
 *
 * This module must never import `./executeAnonymous.js`, which would put the
 * Salesforce SDK back in the startup graph.
 */

import { z } from "zod";
import { DEFAULT_OUTPUT_DIR } from "./logStore.js";
import {
  DEFAULT_TRACE_CONFIG,
  levelsClause,
  LOG_LEVELS,
  TRACE_CATEGORIES,
} from "../salesforce/debugLevels.js";
import { APEX_EXECUTION_DISABLED_MESSAGE } from "../policy/orgExecutionPolicy.js";
import { targetOrgSchema, toolInputSchema } from "./inputSchema.js";
import { absolutePathSchema } from "./localFile.js";

const logLevelSchema = z.enum(LOG_LEVELS);

export const executeAnonymousInputSchema = {
  apex: z
    .string()
    .optional()
    .describe("The anonymous Apex to execute, or use apexFilePath"),
  apexFilePath: absolutePathSchema
    .optional()
    .describe("Absolute path to a file of anonymous Apex"),
  targetOrg: targetOrgSchema,
  outputDir: z
    .string()
    .optional()
    .describe(
      `Directory to save the debug log file (default: ${DEFAULT_OUTPUT_DIR}/ in the first client root)`,
    ),
  // The enums already list the levels and the categories, so the description
  // says only what they cannot: what each form does, and the per-category
  // defaults, read from `DEFAULT_TRACE_CONFIG` so they cannot go stale.
  debugLevel: z
    .union([
      z.enum(["traceFlag", "default", ...LOG_LEVELS]),
      z.partialRecord(z.enum(TRACE_CATEGORIES), logLevelSchema),
    ])
    .optional()
    .describe(
      `This run's log levels. Omit for the user's trace flag levels, else the defaults; "traceFlag" requires the flag; "default" forces the defaults; a bare level sets every category; an object sets the named categories over the defaults. Defaults: ${levelsClause(DEFAULT_TRACE_CONFIG)}.`,
    ),
};

export type ExecuteAnonymousArgs = z.infer<
  z.ZodObject<typeof executeAnonymousInputSchema>
>;

const EXECUTE_ANONYMOUS_DESCRIPTION =
  "Execute anonymous Apex in an authenticated Salesforce org as the targetOrg user; its DML commits unless the run fails. Saves the debug log locally and returns its path for the analysis tools. If the user has no active trace flag, adds a debug level, left in the org, and a trace flag for the run, deleted after.";

/**
 * The tool is always registered so that agents can discover it. When Apex
 * execution is disabled the description says so up front, which saves the agent
 * a call to find out.
 */
export function executeAnonymousToolConfig(apexExecutionDisabled = false) {
  return {
    title: "Execute Anonymous Apex",
    description: apexExecutionDisabled
      ? `[DISABLED on this server] ${EXECUTE_ANONYMOUS_DESCRIPTION} ${APEX_EXECUTION_DISABLED_MESSAGE}`
      : EXECUTE_ANONYMOUS_DESCRIPTION,
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
  };
}
