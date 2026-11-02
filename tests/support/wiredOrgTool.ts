/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  bindOpenOrg,
  type OpenOrg,
  type OrgAccessPolicy,
} from "../../src/salesforce/orgAccess";
import { compileDenyList } from "../../src/policy/orgDenyList";
import { createConfirmationLedger } from "../../src/policy/orgExecutionPolicy";

/**
 * An org tool's handler as the server wires it: `open` is what `bindOpenOrg`
 * returns for the tool's registered name, so a handler's suite runs the deny
 * list and the production gate. It takes `(server, args, ctx, policy)`, so a
 * suite sets the policy in each call.
 */
export function wiredOrgTool<Args, Result>(
  handler: (args: Args, open: OpenOrg, ctx: ServerContext) => Promise<Result>,
  tool: { name: string },
): (
  server: McpServer,
  args: Args,
  ctx: ServerContext,
  policy: OrgAccessPolicy,
) => Promise<Result> {
  return (server, args, ctx, policy) =>
    handler(args, bindOpenOrg(server, ctx, tool.name, policy), ctx);
}

/**
 * A policy that denies nothing and asks before a production write, so a test
 * overrides only the part it is about.
 */
export function testOrgAccessPolicy(
  overrides: Partial<OrgAccessPolicy> = {},
): OrgAccessPolicy {
  return {
    allowProductionOrgs: false,
    denyList: compileDenyList([], "--deny-orgs"),
    writeDenyList: compileDenyList([], "--deny-org-writes"),
    classificationCache: new Map(),
    mintConfirmationState: jest.fn(),
    consumeConfirmation: createConfirmationLedger(),
    ...overrides,
  };
}
