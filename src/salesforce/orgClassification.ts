/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import type { Org } from "@salesforce/core";

/**
 * The subset of the Organization record needed to classify an org.
 *
 * Structurally compatible with `OrganizationInformation` from `@salesforce/core`,
 * which is not exported from the package root.
 */
export type OrganizationRecord = {
  IsSandbox: boolean;
  TrialExpirationDate: string | null;
  OrganizationType: string;
};

export type OrgClassification =
  | "sandbox"
  | "scratch"
  | "developer"
  | "trial"
  | "production"
  | "unknown";

export type OrgTypeResult = {
  classification: OrgClassification;
  /**
   * Why the org type could not be determined. Only set when the classification
   * is "unknown", so that callers can tell the user what to fix.
   */
  unverifiedReason?: string;
};

const DEVELOPER_EDITION = "Developer Edition";

/**
 * Classify an org from its Organization record.
 *
 * Sandbox and scratch orgs are distinguished the same way the Salesforce CLI does
 * it: both have `IsSandbox = true`, and only scratch orgs carry a trial expiry.
 *
 * Anything unrecognised is treated as production so that an unfamiliar edition
 * can never silently bypass the production gate.
 */
export function classifyOrganization(
  info: OrganizationRecord,
): OrgClassification {
  if (info.IsSandbox) {
    return info.TrialExpirationDate ? "scratch" : "sandbox";
  }

  if (info.TrialExpirationDate) {
    return "trial";
  }

  return info.OrganizationType === DEVELOPER_EDITION
    ? "developer"
    : "production";
}

/**
 * Classify the target org, caching the result per org id for the life of the cache.
 *
 * Returns "unknown" with the underlying reason if the org could not be queried.
 * Callers must treat "unknown" as production. The failure is deliberately not
 * cached so that a transient error does not gate every later call in the session.
 */
export async function classifyOrg(
  org: Org,
  cache: Map<string, OrgClassification>,
): Promise<OrgTypeResult> {
  const orgId = org.getOrgId();
  const cached = cache.get(orgId);
  if (cached) {
    return { classification: cached };
  }

  try {
    const classification = classifyOrganization(
      await org.retrieveOrganizationInformation(),
    );
    cache.set(orgId, classification);
    return { classification };
  } catch (error) {
    const unverifiedReason =
      error instanceof Error ? error.message : String(error);
    console.error(
      `[apex-log-mcp] Could not determine the type of org ${orgId}:`,
      unverifiedReason,
    );
    return { classification: "unknown", unverifiedReason };
  }
}
