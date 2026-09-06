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
import {
  DEFAULT_TRACE_CONFIG,
  LOG_LEVELS,
  TRACE_CATEGORIES,
} from "../salesforce/debugLevels.js";
import { APEX_EXECUTION_DISABLED_MESSAGE } from "../policy/orgExecutionPolicy.js";

const logLevelSchema = z.enum(LOG_LEVELS);

/**
 * The defaults, read from `DEFAULT_TRACE_CONFIG` so the description cannot go
 * stale. Categories are grouped by level to keep the wire text short:
 * "apexCode, workflow FINE; callout DEBUG".
 */
function defaultLevelsClause(): string {
  const byLevel = Object.entries(DEFAULT_TRACE_CONFIG).reduce(
    (acc, [category, level]) =>
      acc.set(level, [...(acc.get(level) ?? []), category]),
    new Map<string, string[]>(),
  );

  return [...byLevel]
    .map(([level, categories]) => `${categories.join(", ")} ${level}`)
    .join("; ");
}

export const executeAnonymousInputSchema = {
  apex: z.string().describe("The anonymous Apex to be executed"),
  targetOrg: z
    .string()
    .optional()
    .describe(
      "Alias or username of the target Salesforce org. Uses the project default if not specified.",
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory to save the debug log file. Defaults to .apex-log-mcp/ in the project root.",
    ),
  // The enums already list the levels and the categories, so the description
  // says only what they cannot: what each of the three forms does, and the
  // per-category defaults.
  debugLevel: z
    .union([
      z.enum(["default", ...LOG_LEVELS]),
      z.partialRecord(z.enum(TRACE_CATEGORIES), logLevelSchema),
    ])
    .optional()
    .describe(
      `Trace flag log levels. "default" restores the defaults; a bare level sets every category to it; an object sets only the categories named and leaves the rest unchanged. Defaults: ${defaultLevelsClause()}.`,
    ),
};

export type ExecuteAnonymousArgs = z.infer<
  z.ZodObject<typeof executeAnonymousInputSchema>
>;

const EXECUTE_ANONYMOUS_DESCRIPTION =
  "Execute a snippet of anonymous Apex against an authenticated Salesforce org (via SF CLI). Saves the resulting debug log to a local file and returns a summary with the file path, which the analysis tools accept. Production orgs require per-call user confirmation or the --allow-production-orgs server flag.";

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
    inputSchema: executeAnonymousInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}
