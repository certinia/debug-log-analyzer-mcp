/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  isOrgClassification,
  ORG_CLASSIFICATIONS,
  type OrgClassification,
} from "../salesforce/orgClassification.js";

/**
 * A deny pattern, kept beside its matcher so a refusal can name what matched.
 *
 * `source` is the pattern as the user wrote it. `RegExp.source` holds the
 * compiled form, which nobody typed and nobody would recognise.
 */
export type DenyPattern = {
  source: string;
  regexp: RegExp;
};

/**
 * What is known about the target org before it is queried.
 *
 * Every field comes from the local auth file, so a deny is decided without
 * contacting the org. Only `orgId` is unspoofable - an alias can be re-pointed
 * at another org - so the rest are a convenience, not a security boundary.
 */
export type OrgIdentity = {
  orgId: string;
  username: string;
  alias?: string;
  instanceUrl?: string;
};

/** Every character `RegExp` reads as syntax, less `*`, which is the glob. */
const REGEXP_METACHARACTERS = /[.+?^${}()|[\]\\]/g;

export const DENY_IS_ABSOLUTE =
  "A deny is absolute: no flag and no confirmation lifts it.";

/**
 * Compile one pattern.
 *
 * `*` matches any run of characters and every other metacharacter is literal.
 * Anchored and case-insensitive, so `prod-*@acme.com` denies `PROD-a@acme.com`
 * and not `xprod-a@acme.com`.
 */
function compile(source: string): RegExp {
  const body = source
    .split("*")
    .map((literal) => literal.replace(REGEXP_METACHARACTERS, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Split a repeatable, comma-separated flag into its values.
 *
 * Case is left as written, because `compile` matches without regard to it and
 * a refusal has to echo the pattern the user typed.
 */
export function parseDenyOrgPatterns(raw: string[]): string[] {
  return raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Validate `--deny-org-types`.
 *
 * Throws, so a typo fails the server at startup. A pattern cannot be validated
 * this way - one that matches nothing is indistinguishable from one that has
 * yet to match - which is why the two are separate flags.
 */
export function parseDenyOrgTypes(raw: string[]): OrgClassification[] {
  return parseDenyOrgPatterns(raw).map((value) => {
    const type = value.toLowerCase();
    if (!isOrgClassification(type)) {
      throw new Error(
        `--deny-org-types: '${value}' is not an org type. Use one of: ${ORG_CLASSIFICATIONS.join(", ")}.`,
      );
    }
    return type;
  });
}

/** Cleans its input, so a hand-built configuration behaves like a parsed one. */
export function compileDenyOrgs(sources: string[]): DenyPattern[] {
  return parseDenyOrgPatterns(sources).map((source) => ({
    source,
    regexp: compile(source),
  }));
}

/**
 * The first pattern that denies this org, or `undefined`.
 *
 * Matched against everything the auth file knows, so a deny on the username
 * cannot be dodged by naming the alias.
 */
export function matchDeniedOrg(
  patterns: DenyPattern[],
  identity: OrgIdentity,
): DenyPattern | undefined {
  const fields = [
    identity.orgId,
    identity.username,
    identity.alias,
    identity.instanceUrl,
  ].filter((field): field is string => !!field);

  return patterns.find((pattern) =>
    fields.some((field) => pattern.regexp.test(field)),
  );
}

function denyRefusal(orgLabel: string, because: string): string {
  return `Cannot execute anonymous Apex against org '${orgLabel}': ${because}.\n${DENY_IS_ABSOLUTE}`;
}

export function denyOrgRefusal(orgLabel: string, pattern: DenyPattern): string {
  return denyRefusal(
    orgLabel,
    `it matches the --deny-orgs pattern '${pattern.source}'`,
  );
}

export function denyOrgTypeRefusal(
  orgLabel: string,
  classification: OrgClassification,
): string {
  return denyRefusal(
    orgLabel,
    `its type is '${classification}', which --deny-org-types denies`,
  );
}
