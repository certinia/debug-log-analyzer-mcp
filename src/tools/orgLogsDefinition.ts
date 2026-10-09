/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * What `tools/list` puts on the wire for the org log tools, apart from their
 * handlers, which `src/server.ts` loads lazily. Like
 * `executeAnonymousDefinition.ts`, this must never import a module that loads
 * the Salesforce SDK.
 */

import { z } from "zod";
import { isApexLogId, LOG_SORTS } from "../salesforce/apexLogs.js";
import { targetOrgSchema, toolInputSchema } from "./inputSchema.js";

/** Per `apexlog_get_org_logs` call, so one call cannot download for minutes. */
const MAX_LOGS_PER_GET = 25;

// Refinements, not `.regex` or `z.iso`, whose patterns cost 89 wire tokens per date-time field.
const logId = z
  .string()
  .refine(isApexLogId, "must be a debug log id, 07L…");

const dateTime = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
    "must be an ISO 8601 date-time with a zone, e.g. 2026-10-09T09:00:00Z",
  );

export const listOrgLogsInputSchema = {
  targetOrg: targetOrgSchema,
  user: z.string().optional().describe("Username whose activity was logged"),
  operation: z
    .string()
    .optional()
    .describe('Part of the operation, any case, e.g. "aura" for /aura'),
  request: z.string().optional().describe('e.g. "Api" or "Application"'),
  succeeded: z
    .boolean()
    .optional()
    .describe("false for failed logs only"),
  startTimeFrom: dateTime
    .optional()
    .describe("ISO 8601 with a zone, e.g. 2026-10-09T09:00:00Z"),
  startTimeTo: dateTime.optional(),
  minFileSizeBytes: z.number().int().nonnegative().optional(),
  sortBy: z
    .enum(LOG_SORTS)
    .optional()
    .describe("Newest, slowest or largest first (default: startTime)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Rows per page (default: 20)"),
  cursor: z
    .string()
    .optional()
    .describe("nextCursor from the previous page, with the same filters and sortBy"),
};

export type ListOrgLogsArgs = z.infer<
  z.ZodObject<typeof listOrgLogsInputSchema>
>;

export const listOrgLogsToolConfig = {
  title: "List Org Debug Logs",
  description:
    "List the debug logs stored in a Salesforce org, with how many match. Pass ids to apexlog_get_org_logs to download them.",
  inputSchema: toolInputSchema(listOrgLogsInputSchema),
  annotations: {
    readOnlyHint: true,
  },
};

export const getOrgLogsInputSchema = {
  targetOrg: targetOrgSchema,
  ids: z
    .array(logId)
    .min(1)
    .max(MAX_LOGS_PER_GET)
    .optional()
    .describe("Log ids, from apexlog_list_org_logs"),
  latest: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOGS_PER_GET)
    .optional()
    .describe("The newest N logs, in place of ids (default: 1)"),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Directory to save the debug log files. Defaults to .apex-log-mcp/ in the project root.",
    ),
};

export type GetOrgLogsArgs = z.infer<z.ZodObject<typeof getOrgLogsInputSchema>>;

export const getOrgLogsToolConfig = {
  title: "Get Org Debug Logs",
  description:
    "Download debug logs from a Salesforce org, by id or the newest N, and return each saved file's path, which the analysis tools accept.",
  inputSchema: toolInputSchema(getOrgLogsInputSchema),
  // Writes local files and nothing in the org; not idempotent, because `latest` names newer logs over time.
  annotations: {
    destructiveHint: false,
  },
};
