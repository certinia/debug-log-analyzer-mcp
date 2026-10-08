/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { createHash, randomBytes } from "node:crypto";
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
 * digest of the effect rather than the effect: the client can read it.
 *
 * `nonce` names this one confirmation, so the answer can be spent. The rest is
 * what the re-sent call is checked against. `tool` is there because every tool
 * is called through the one method the codec binds, `tools/call`.
 */
export type ConfirmationState = {
  tool: string;
  orgId: string;
  effectDigest: string;
  nonce: string;
};

/** A write, as a production confirmation shows it and binds it. */
export type Confirmable = {
  /** What the confirmation is bound to; only its digest is signed. */
  effect: string;
  /** Shown in full between the preamble and the question. */
  detail: string;
  /** The confirm field's title, before " against … org '…'?". */
  title: string;
  /** When set, the refusal to return instead of asking: the write cannot be shown whole. */
  unshowable?: string;
};

/** How long a confirmation stays answerable. */
export const CONFIRMATION_TTL_SECONDS = 600;

/**
 * Mints the signed state that a confirmation round-trips through the client.
 * The context is passed on to the codec, which binds the state to it.
 */
export type MintConfirmationState = (
  payload: ConfirmationState,
  ctx: ServerContext,
) => Promise<string>;

/** Spends a confirmation. False when this one was spent already. */
export type ConsumeConfirmation = (nonce: string) => boolean;

/**
 * One answer authorizes one call.
 *
 * The signed state proves the user was asked, not that the call it authorized
 * has not happened yet: a client that re-sends the same confirmed call does
 * the write again, as often as it likes until the signature expires. So each answer
 * is spent on first use, and the ledger holds nothing past the point the codec
 * refuses the signature anyway.
 */
export function createConfirmationLedger(
  ttlSeconds: number = CONFIRMATION_TTL_SECONDS,
): ConsumeConfirmation {
  const spentAt = new Map<string, number>();
  return (nonce) => {
    const now = Date.now();
    for (const [spent, at] of spentAt) {
      if (now - at >= ttlSeconds * 1000) {
        spentAt.delete(spent);
      }
    }
    if (spentAt.has(nonce)) {
      return false;
    }
    spentAt.set(nonce, now);
    return true;
  };
}

/** The key this server assigns its one embedded request, and reads back. */
const CONFIRM_KEY = "confirm";

const confirmSchema = z.object({ confirm: z.boolean() });

/** Underlying API errors can be verbose; keep the actionable part. */
const MAX_REASON = 300;

export const APEX_EXECUTION_DISABLED_MESSAGE =
  "Anonymous Apex execution is disabled by server configuration (--no-apex-execution). " +
  "The log analysis tools remain available.";

export function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * The refusal a server started with `--no-apex-execution` owes every call, or
 * `undefined` when execution is allowed.
 *
 * Asked by the registered handler before it loads the tool, and by the tool
 * itself for a direct caller, so the decision exists once and a disabled server
 * loads no Salesforce SDK at all.
 */
export function apexExecutionRefusal(apexExecutionDisabled: boolean) {
  return apexExecutionDisabled
    ? toolError(APEX_EXECUTION_DISABLED_MESSAGE)
    : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (truncated)`;
}

function digestOf(effect: string): string {
  return createHash("sha256").update(effect, "utf8").digest("hex");
}

const ENABLE_HINT =
  "To proceed anyway: restart the server with --allow-production-orgs, or use a client " +
  "that supports MCP elicitation for per-call confirmation.";

function refusal(
  action: string,
  orgLabel: string,
  unverifiedReason?: string,
): string {
  if (unverifiedReason) {
    return (
      `Cannot ${action} against org '${orgLabel}': its type could not be verified, ` +
      "so it is treated as production to prevent accidental data loss.\n" +
      `Reason: ${truncate(unverifiedReason, MAX_REASON)}\n` +
      "If the org's authentication has expired, re-authenticate it (for example " +
      "'sf org login web --alias <alias>') and try again.\n" +
      ENABLE_HINT
    );
  }

  return (
    `Cannot ${action} against production org '${orgLabel}'.\n` +
    "This server blocks production targets by default to prevent accidental data loss.\n" +
    ENABLE_HINT
  );
}

function confirmationRequest(
  action: string,
  orgLabel: string,
  confirm: Confirmable,
  unverifiedReason?: string,
) {
  const preamble = unverifiedReason
    ? `About to ${action} against org '${orgLabel}', whose type could not be ` +
      `verified (treated as production).\nReason: ${truncate(unverifiedReason, MAX_REASON)}`
    : `About to ${action} against PRODUCTION org '${orgLabel}'.`;

  return inputRequired.elicit({
    message: `${preamble}\n\n${confirm.detail}\n\nProceed?`,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          // Drop the classification when it could not be verified.
          title: `${confirm.title} against ${unverifiedReason ? "" : "production "}org '${orgLabel}'?`,
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
 * Decide whether a write may go ahead against the classified target org.
 *
 * Non-production orgs go ahead silently. Production orgs (and orgs whose type
 * could not be verified) need either the --allow-production-orgs flag or an
 * explicit, per-call user confirmation.
 *
 * The confirmation is a multi-round-trip: the first call returns the request,
 * and the client re-sends the same call carrying the answer. The whole handler
 * runs again on that second call, so this decides afresh both times. The SDK
 * has already proven the state's integrity by the time it reaches here; what it
 * cannot know is whether the retry asks for the same write, which is why the
 * state binds the tool, its effect and the org and is compared against the re-sent call,
 * nor that the call it authorized has not already happened, which is why the
 * answer is spent on first use.
 */
export async function authorizeOperation(opts: {
  ctx: ServerContext;
  mintConfirmationState: MintConfirmationState;
  classification: OrgClassification;
  orgId: string;
  orgLabel: string;
  allowProductionOrgs: boolean;
  consumeConfirmation: ConsumeConfirmation;
  unverifiedReason?: string;
  tool: string;
  action: string;
  confirm: Confirmable;
}): Promise<PolicyDecision> {
  const {
    ctx,
    classification,
    orgId,
    orgLabel,
    allowProductionOrgs,
    tool,
    action,
    confirm,
  } = opts;

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

  if (confirm.unshowable !== undefined) {
    return { outcome: "refused", reason: confirm.unshowable };
  }

  const confirmed = ctx.mcpReq.requestState<ConfirmationState>();

  if (!confirmed) {
    return {
      outcome: "confirmationRequired",
      result: inputRequired({
        inputRequests: {
          [CONFIRM_KEY]: confirmationRequest(
            action,
            orgLabel,
            confirm,
            unverifiedReason,
          ),
        },
        requestState: await opts.mintConfirmationState(
          {
            tool,
            orgId,
            effectDigest: digestOf(confirm.effect),
            nonce: randomBytes(16).toString("hex"),
          },
          ctx,
        ),
      }),
    };
  }

  if (
    confirmed.tool !== tool ||
    confirmed.orgId !== orgId ||
    confirmed.effectDigest !== digestOf(confirm.effect)
  ) {
    return {
      outcome: "refused",
      reason:
        `The confirmation does not match this call: the tool, what it would do or the target org ` +
        `changed after it was given, so nothing was done against '${orgLabel}'. Ask again to ${action}.`,
    };
  }

  // A client that echoes the state but carries no answer cannot confirm at all,
  // so it gets the routes that need no confirmation rather than a decline.
  if (inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY).kind === "missing") {
    return {
      outcome: "refused",
      reason: refusal(action, orgLabel, unverifiedReason),
    };
  }

  const answer = acceptedContent(
    ctx.mcpReq.inputResponses,
    CONFIRM_KEY,
    confirmSchema,
  );

  if (answer?.confirm === true) {
    if (!opts.consumeConfirmation(confirmed.nonce)) {
      return {
        outcome: "refused",
        reason:
          `The confirmation has already been used, and one confirmation authorizes one call, ` +
          `so nothing was done against '${orgLabel}'. Ask again to ${action}.`,
      };
    }
    return { outcome: "allowed" };
  }

  return {
    outcome: "refused",
    reason: unverifiedReason
      ? `User declined to ${action} against org '${orgLabel}'.`
      : `User declined to ${action} against production org '${orgLabel}'.`,
  };
}
