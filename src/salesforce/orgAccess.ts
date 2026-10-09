/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { fileURLToPath } from "node:url";
import {
  CLIENT_CAPABILITIES_META_KEY,
  SdkError,
  SdkErrorCode,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { Connection } from "@salesforce/core";
import { connectOrg, readLocalOrg, type LocalOrg } from "./connection.js";
import { classifyOrg, type OrgClassification } from "./orgClassification.js";
import {
  authorizeOperation,
  toolError,
  type Confirmable,
  type ConsumeConfirmation,
  type MintConfirmationState,
} from "../policy/orgExecutionPolicy.js";
import {
  identityRefusal,
  typeRefusal,
  type DenyList,
} from "../policy/orgDenyList.js";

const ROOTS_TIMEOUT_MS = 5_000;

/** What every org tool is held to, whatever it does once it is in. */
export type OrgAccessPolicy = {
  allowProductionOrgs: boolean;
  denyList: DenyList;
  classificationCache: Map<string, OrgClassification>;
  mintConfirmationState: MintConfirmationState;
  consumeConfirmation: ConsumeConfirmation;
};

// `unknown` when the client declared roots this server could not use: then nothing can be checked against them.
export type Workspace =
  | { kind: "roots"; paths: string[] }
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

/** What a tool asks of `openOrg`. */
export type OrgRequest<T, V = T> = {
  /** The tool's name, which a production confirmation is bound to. */
  tool: string;
  /** What the call does, as a verb phrase: every refusal is built from it. */
  action: string;
  targetOrg?: string;
  report?: (step: string) => Promise<void>;
  /** A refusal for this call when the roots cannot be used, or undefined. */
  unknownRoots?: (reason: string) => string | undefined;
  /**
   * The call's own work before the org is contacted: after the identity deny,
   * so a denied org costs nothing, and before connecting, so a bad input costs
   * no call to the org.
   */
  prepare?: (rootPaths: string[]) => Promise<T>;
  /**
   * `false` for a read. A write reads what it needs from the connected org and
   * returns it with what a production org must confirm, so it does exactly
   * what was confirmed. Required, so no write skips the gate by leaving it out;
   * `confirm: null` says, explicitly, that the write found nothing to change.
   */
  write:
    | false
    | ((org: {
        value: T;
        connection: Connection;
        local: LocalOrg;
        orgLabel: string;
      }) => Promise<{ value: V; confirm: Confirmable | null }>);
};

export type OrgAccess<T> =
  | {
      granted: true;
      value: T;
      connection: Connection;
      local: LocalOrg;
      orgLabel: string;
      classification: OrgClassification;
      workspace: Workspace;
      rootPaths: string[];
    }
  | { granted: false; result: CallToolResult | InputRequiredResult };

/**
 * Resolve, check and connect to the target org, in the one order every org
 * tool must keep: roots, then the local org, then the identity deny before
 * anything can call the org, then the type deny and, for a write, the
 * production gate, before the tool changes anything. A refusal is returned; a
 * fault still throws.
 */
export async function openOrg<T = undefined, V = T>(
  server: McpServer,
  ctx: ServerContext,
  request: OrgRequest<T, V>,
  policy: OrgAccessPolicy,
): Promise<OrgAccess<V>> {
  const refuse = (text: string): OrgAccess<V> => ({
    granted: false,
    result: toolError(text),
  });

  const workspace = await getWorkspace(server, ctx);
  // Fail closed, before any local work: unusable roots bound no file and name no project.
  if (workspace.kind === "unknown") {
    const refused =
      request.unknownRoots?.(workspace.reason) ??
      (request.targetOrg === undefined
        ? `Cannot tell which project's default org to use: ${workspace.reason}. Pass targetOrg.`
        : undefined);
    if (refused !== undefined) {
      return refuse(refused);
    }
  }
  const rootPaths = workspace.kind === "roots" ? workspace.paths : [];

  const local = await readLocalOrg(rootPaths[0], request.targetOrg);
  const alias = local.aliases[0];
  const orgLabel = alias ? `${local.username} (${alias})` : local.username;

  // Before connecting, because Org.create can call the org.
  const deniedUnseen = identityRefusal(
    policy.denyList,
    request.action,
    orgLabel,
    local,
  );
  if (deniedUnseen) {
    return refuse(deniedUnseen);
  }

  const value = request.prepare
    ? await request.prepare(rootPaths)
    : (undefined as T);

  await request.report?.("Connecting to the org");
  const org = await connectOrg(local);

  const { classification, unverifiedReason } = await classifyOrg(
    org,
    policy.classificationCache,
  );
  // Before the production gate, so no flag and no confirmation can lift it.
  const deniedType = typeRefusal(
    policy.denyList,
    request.action,
    orgLabel,
    classification,
  );
  if (deniedType) {
    return refuse(deniedType);
  }

  const connection = org.getConnection();
  // A read's value is what `prepare` gave; only a write's hook can change it.
  let result = value as unknown as V;
  if (request.write) {
    const planned = await request.write({ value, connection, local, orgLabel });
    result = planned.value;
    // Nothing to change is nothing to confirm: asking would put a no-op to a person as a destructive prompt.
    if (planned.confirm) {
      const decision = await authorizeOperation({
        ctx,
        mintConfirmationState: policy.mintConfirmationState,
        consumeConfirmation: policy.consumeConfirmation,
        classification,
        orgId: local.orgId,
        orgLabel,
        allowProductionOrgs: policy.allowProductionOrgs,
        unverifiedReason,
        tool: request.tool,
        action: request.action,
        confirm: planned.confirm,
      });
      if (decision.outcome === "confirmationRequired") {
        return { granted: false, result: decision.result };
      }
      if (decision.outcome === "refused") {
        return refuse(decision.reason);
      }
    }
  }

  return {
    granted: true,
    value: result,
    connection,
    local,
    orgLabel,
    classification,
    workspace,
    rootPaths,
  };
}

async function getWorkspace(
  server: McpServer,
  ctx: ServerContext,
): Promise<Workspace> {
  const { signal } = ctx.mcpReq;
  try {
    // Bounded, so a client that never answers costs seconds, not the SDK's 60 s default.
    const { roots } = await server.server.listRoots(undefined, {
      timeout: ROOTS_TIMEOUT_MS,
      signal,
    });
    // One by one, so a root this machine cannot use costs only that root.
    const paths = roots.flatMap((root) => {
      try {
        // fileURLToPath decodes `%20` and drops the slash before a Windows drive, which `pathname` keeps.
        return root.uri.startsWith("file:") ? [fileURLToPath(root.uri)] : [];
      } catch {
        return [];
      }
    });
    return paths.length > 0
      ? { kind: "roots", paths }
      : { kind: "unknown", reason: "the client lists no roots on this machine" };
  } catch (error) {
    // A cancelled call stops here, rather than running on with no roots.
    if (signal.aborted) {
      throw error;
    }
    if (!(error instanceof SdkError)) {
      return {
        kind: "unknown",
        reason: `the client's roots could not be read: ${String(error)}`,
      };
    }
    switch (error.code) {
      // Only a client that declared no roots has none to check against.
      case SdkErrorCode.CapabilityNotSupported:
        return { kind: "none" };
      case SdkErrorCode.MethodNotSupportedByProtocolVersion: {
        // 2026-07-28 fails before the capability check, so read the request's own declaration.
        const declared = (
          ctx.mcpReq.envelope as
            | Record<string, { roots?: unknown } | undefined>
            | undefined
        )?.[CLIENT_CAPABILITIES_META_KEY];
        return declared?.roots
          ? {
              kind: "unknown",
              reason:
                "this server cannot yet ask a 2026-07-28 client for its roots",
            }
          : { kind: "none" };
      }
      default:
        return {
          kind: "unknown",
          reason: `the client's roots could not be read: ${error.message}`,
        };
    }
  }
}
