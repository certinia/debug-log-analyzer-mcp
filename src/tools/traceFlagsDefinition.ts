/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What `tools/list` puts on the wire for the trace flag tools, apart from their
 * handlers, which `src/server.ts` loads lazily. Like
 * `executeAnonymousDefinition.ts`, this must never import a module that loads
 * the Salesforce SDK.
 */

import { z } from "zod";
import { isSalesforceId } from "../salesforce/soql.js";
import { LOG_LEVELS, TRACE_CATEGORIES } from "../salesforce/debugLevels.js";
import {
  IDS_PER_QUERY,
  MAX_DURATION_MINUTES,
} from "../salesforce/traceFlags.js";
import { targetOrgSchema, toolInputSchema } from "./inputSchema.js";

const tracedEntity = z
  .string()
  .describe("A username or user id, or a class or trigger name (ns.Name if namespaced)");

export const listTraceFlagsInputSchema = {
  targetOrg: targetOrgSchema,
  tracedEntity: tracedEntity.optional(),
};

export type ListTraceFlagsArgs = z.infer<
  z.ZodObject<typeof listTraceFlagsInputSchema>
>;

export const listTraceFlagsToolConfig = {
  title: "List Trace Flags",
  description:
    `List the trace flags in a Salesforce org that have not yet expired, with their levels, the ${IDS_PER_QUERY} latest to expire and how many match: a debug log is stored only for a user a flag traces.`,
  inputSchema: toolInputSchema(listTraceFlagsInputSchema),
  annotations: {
    readOnlyHint: true,
  },
};

export const createTraceFlagInputSchema = {
  targetOrg: targetOrgSchema,
  tracedEntity,
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
    "Start logging a user in a Salesforce org with a trace flag: every transaction they run is stored as a debug log until the flag expires, which can fill the org's log storage. A class or trigger flag stores no log, only sets that code's levels. Refused when the entity has a flag of its log type.",
  inputSchema: toolInputSchema(createTraceFlagInputSchema),
  annotations: {
    destructiveHint: false,
  },
};

export const deleteTraceFlagsInputSchema = {
  targetOrg: targetOrgSchema,
  ids: z
    .array(
      z
        .string()
        .refine((id) => isSalesforceId(id, "7tf"), "must be a trace flag id, 7tf…"),
    )
    .min(1)
    .max(IDS_PER_QUERY)
    .describe("Trace flag ids, from apexlog_list_trace_flags"),
};

export type DeleteTraceFlagsArgs = z.infer<
  z.ZodObject<typeof deleteTraceFlagsInputSchema>
>;

export const deleteTraceFlagsToolConfig = {
  title: "Delete Trace Flags",
  description:
    "Delete trace flags from a Salesforce org, to stop logging now: a flag cannot be ended early by editing it.",
  inputSchema: toolInputSchema(deleteTraceFlagsInputSchema),
  annotations: {
    destructiveHint: true,
  },
};
