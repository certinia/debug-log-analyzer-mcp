/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What `tools/list` puts on the wire for apexlog_create_trace_flag, apart from
 * its handler, which `src/server.ts` loads lazily. Like
 * `executeAnonymousDefinition.ts`, this must never import a module that loads
 * the Salesforce SDK.
 */

import { z } from "zod";
import { describeDisabled } from "../policy/orgExecutionPolicy.js";
import { LOG_LEVELS } from "../logLevels.js";
import { MAX_DURATION_MINUTES } from "../salesforce/traceFlags.js";
import { levelsByCategorySchema, targetOrgSchema, toolInputSchema } from "./inputSchema.js";

const createTraceFlagInputSchema = {
  targetOrg: targetOrgSchema,
  tracedEntity: z
    .string()
    .describe("A username or user id, or a class or trigger name (ns.Name if namespaced)"),
  debugLevel: z
    .union([
      z.enum(LOG_LEVELS),
      levelsByCategorySchema,
    ])
    .optional()
    .describe(
      "A level for every category, or the named ones over apexlog_execute_anonymous's defaults (default: those)",
    ),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_DURATION_MINUTES)
    .optional()
    .describe("How long it logs (default: 30)"),
};

export type CreateTraceFlagArgs = z.infer<
  z.ZodObject<typeof createTraceFlagInputSchema>
>;

const CREATE_TRACE_FLAG_DESCRIPTION =
  "Trace a user, class or trigger in a Salesforce org until the trace flag expires. A user's flag stores each transaction they run as a debug log, which can fill log storage; a class or trigger flag only sets that code's levels. Refused if a flag of its log type overlaps the new one. Leaves a debug level in the org.";

/** `refusal` is what this server answers every call, or undefined when it writes to orgs. */
export function createTraceFlagTool(refusal?: string) {
  return {
    name: "apexlog_create_trace_flag",
    config: {
      title: "Create Trace Flag",
      description: describeDisabled(CREATE_TRACE_FLAG_DESCRIPTION, refusal),
      inputSchema: toolInputSchema(createTraceFlagInputSchema),
      annotations: {
        destructiveHint: false,
      },
    },
    refusal,
  };
}
