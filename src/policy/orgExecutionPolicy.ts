/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrgClassification } from "../salesforce/orgClassification.js";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/** How long to wait for the user to answer a confirmation prompt. */
const ELICITATION_TIMEOUT_MS = 60_000;

/** Keep the prompt readable, and out of the way of client UI limits. */
const MAX_APEX_IN_PROMPT = 2000;

/** Underlying API errors can be verbose; keep the actionable part. */
const MAX_REASON = 300;

export const APEX_EXECUTION_DISABLED_MESSAGE =
  "Anonymous Apex execution is disabled by server configuration (--no-apex-execution). " +
  "The log analysis tools remain available.";

function truncate(apex: string, max: number): string {
  return apex.length <= max ? apex : `${apex.slice(0, max)}\n... (truncated)`;
}

const ENABLE_HINT =
  "To proceed anyway: restart the server with --allow-production-orgs, or use a client " +
  "that supports MCP elicitation for per-call confirmation.";

function refusal(orgLabel: string, unverifiedReason?: string): string {
  if (unverifiedReason) {
    return (
      `Cannot execute anonymous Apex against org '${orgLabel}': its type could not be verified, ` +
      "so it is treated as production to prevent accidental data loss.\n" +
      `Reason: ${truncate(unverifiedReason, MAX_REASON)}\n` +
      "If the org's authentication has expired, re-authenticate it (for example " +
      "'sf org login web --alias <alias>') and try again.\n" +
      ENABLE_HINT
    );
  }

  return (
    `Cannot execute anonymous Apex against production org '${orgLabel}'.\n` +
    "This server blocks production targets by default to prevent accidental data loss.\n" +
    ENABLE_HINT
  );
}

async function confirmWithUser(
  server: McpServer,
  orgLabel: string,
  apex: string,
  unverifiedReason?: string,
): Promise<boolean> {
  const preamble = unverifiedReason
    ? `About to execute anonymous Apex against org '${orgLabel}', whose type could not be ` +
      `verified (treated as production).\nReason: ${truncate(unverifiedReason, MAX_REASON)}`
    : `About to execute anonymous Apex against PRODUCTION org '${orgLabel}'.`;

  const result = await server.server.elicitInput(
    {
      message:
        `${preamble}\n\nApex:\n${truncate(apex, MAX_APEX_IN_PROMPT)}\n\nProceed?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            // Drop the classification when it could not be verified.
            title: `Run against ${unverifiedReason ? "" : "production "}org '${orgLabel}'?`,
            description: "true to run, false to cancel",
            // A client that applies defaults should pre-fill "no".
            default: false,
          },
        },
        required: ["confirm"],
      },
    },
    { timeout: ELICITATION_TIMEOUT_MS },
  );

  return result.action === "accept" && result.content?.confirm === true;
}

/**
 * Decide whether anonymous Apex may run against the classified target org.
 *
 * Non-production orgs run silently. Production orgs (and orgs whose type could not
 * be verified) need either the --allow-production-orgs flag or an explicit,
 * per-call user confirmation via MCP elicitation.
 */
export async function authorizeExecution(opts: {
  server: McpServer;
  classification: OrgClassification;
  orgLabel: string;
  apex: string;
  allowProductionOrgs: boolean;
  unverifiedReason?: string;
}): Promise<PolicyDecision> {
  const { server, classification, orgLabel, apex, allowProductionOrgs } = opts;

  if (classification !== "production" && classification !== "unknown") {
    return { allowed: true };
  }

  if (allowProductionOrgs) {
    return { allowed: true };
  }

  // Only trust the reason when it actually explains an unknown classification.
  const unverifiedReason =
    classification === "unknown"
      ? (opts.unverifiedReason ?? "The reason was not reported.")
      : undefined;

  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return { allowed: false, reason: refusal(orgLabel, unverifiedReason) };
  }

  try {
    if (await confirmWithUser(server, orgLabel, apex, unverifiedReason)) {
      return { allowed: true };
    }
  } catch (error) {
    console.error(
      "[apex-log-mcp] Confirmation prompt failed:",
      error instanceof Error ? error.message : error,
    );
    return { allowed: false, reason: refusal(orgLabel, unverifiedReason) };
  }

  return {
    allowed: false,
    reason: unverifiedReason
      ? `User declined the execution against '${orgLabel}'.`
      : `User declined the production-org execution against '${orgLabel}'.`,
  };
}
