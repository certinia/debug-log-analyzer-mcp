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
import { LOG_LEVELS, TRACE_CATEGORIES } from "../salesforce/debugLevels.js";
import { MAX_DURATION_MINUTES } from "../salesforce/traceFlags.js";
import { targetOrgSchema, toolInputSchema } from "./inputSchema.js";

const createTraceFlagInputSchema = {
  targetOrg: targetOrgSchema,
  tracedEntity: z
    .string()
    .describe("A username or user id, or a class or trigger name (ns.Name if namespaced)"),
  debugLevel: z
    .union([
      z.enum(LOG_LEVELS),
      z.partialRecord(z.enum(TRACE_CATEGORIES), z.enum(LOG_LEVELS)),
    ])
    .optional()
    .describe(
      "A level for every category, or an object setting the named ones over apexlog_execute_anonymous's defaults (default: those defaults)",
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

export const createTraceFlagToolConfig = {
  title: "Create Trace Flag",
  description:
    "Start logging a user in a Salesforce org with a trace flag: every transaction they run is stored as a debug log until the flag expires, which can fill the org's log storage. A class or trigger flag stores no log, only sets that code's levels. Refused when the entity has a flag of its log type. Leaves a debug level in the org.",
  inputSchema: toolInputSchema(createTraceFlagInputSchema),
  annotations: {
    destructiveHint: false,
  },
};
