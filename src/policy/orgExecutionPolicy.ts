/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { createHash } from "node:crypto";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OrgClassification } from "../salesforce/orgClassification.js";

export type PolicyDecision =
  | { outcome: "allowed" }
  | { outcome: "refused"; reason: string }
  /** The caller must answer the confirmation and re-send the same call. */
  | { outcome: "confirmationRequired"; result: InputRequiredResult };

/**
 * What a confirmation is bound to. Signed, not encrypted, so it carries a
 * digest of the Apex rather than the Apex: the client can read it.
 */
export type ConfirmationState = {
  apexDigest: string;
  orgId: string;
};

/** Mints the signed state that a confirmation round-trips through the client. */
export type MintConfirmationState = (
  payload: ConfirmationState,
) => Promise<string>;

/** The key this server assigns its one embedded request, and reads back. */
const CONFIRM_KEY = "confirm";

const confirmSchema = z.object({ confirm: z.boolean() });

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

function digestOf(apex: string): string {
  return createHash("sha256").update(apex, "utf8").digest("hex");
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

function confirmationRequest(
  orgLabel: string,
  apex: string,
  unverifiedReason?: string,
) {
  const preamble = unverifiedReason
    ? `About to execute anonymous Apex against org '${orgLabel}', whose type could not be ` +
      `verified (treated as production).\nReason: ${truncate(unverifiedReason, MAX_REASON)}`
    : `About to execute anonymous Apex against PRODUCTION org '${orgLabel}'.`;

  return inputRequired.elicit({
    message: `${preamble}\n\nApex:\n${truncate(apex, MAX_APEX_IN_PROMPT)}\n\nProceed?`,
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
  });
}

/**
 * Decide whether anonymous Apex may run against the classified target org.
 *
 * Non-production orgs run silently. Production orgs (and orgs whose type could
 * not be verified) need either the --allow-production-orgs flag or an explicit,
 * per-call user confirmation.
 *
 * The confirmation is a multi-round-trip: the first call returns the request,
 * and the client re-sends the same call carrying the answer. The whole handler
 * runs again on that second call, so this decides afresh both times. The SDK
 * has already proven the state's integrity by the time it reaches here; what it
 * cannot know is whether the retry asks for the same run, which is why the
 * state binds the Apex and the org and is compared against the re-sent call.
 */
export async function authorizeExecution(opts: {
  ctx: ServerContext;
  mintConfirmationState: MintConfirmationState;
  classification: OrgClassification;
  orgId: string;
  orgLabel: string;
  apex: string;
  allowProductionOrgs: boolean;
  unverifiedReason?: string;
}): Promise<PolicyDecision> {
  const { ctx, classification, orgId, orgLabel, apex, allowProductionOrgs } =
    opts;

  if (classification !== "production" && classification !== "unknown") {
    return { outcome: "allowed" };
  }

  if (allowProductionOrgs) {
    return { outcome: "allowed" };
  }

  // Only trust the reason when it actually explains an unknown classification.
  const unverifiedReason =
    classification === "unknown"
      ? (opts.unverifiedReason ?? "The reason was not reported.")
      : undefined;

  const confirmed = ctx.mcpReq.requestState<ConfirmationState>();

  if (!confirmed) {
    return {
      outcome: "confirmationRequired",
      result: inputRequired({
        inputRequests: {
          [CONFIRM_KEY]: confirmationRequest(orgLabel, apex, unverifiedReason),
        },
        requestState: await opts.mintConfirmationState({
          apexDigest: digestOf(apex),
          orgId,
        }),
      }),
    };
  }

  if (confirmed.orgId !== orgId || confirmed.apexDigest !== digestOf(apex)) {
    return {
      outcome: "refused",
      reason:
        `The confirmation does not match this call: the Apex or the target org changed after it ` +
        `was given, so nothing was executed against '${orgLabel}'. Ask again to run this Apex.`,
    };
  }

  // A client that echoes the state but carries no answer cannot confirm at all,
  // so it gets the routes that need no confirmation rather than a decline.
  if (inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY).kind === "missing") {
    return { outcome: "refused", reason: refusal(orgLabel, unverifiedReason) };
  }

  const answer = acceptedContent(
    ctx.mcpReq.inputResponses,
    CONFIRM_KEY,
    confirmSchema,
  );

  if (answer?.confirm === true) {
    return { outcome: "allowed" };
  }

  return {
    outcome: "refused",
    reason: unverifiedReason
      ? `User declined the execution against '${orgLabel}'.`
      : `User declined the production-org execution against '${orgLabel}'.`,
  };
}
