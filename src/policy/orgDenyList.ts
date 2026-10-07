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
export type DenyPattern =
  | { source: string; kind: "glob"; regexp: RegExp }
  | { source: string; kind: "orgId"; orgId15: string };

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

/** An org id: 15 chars as Setup shows it, or 18 as the auth file holds it. */
const ORG_ID = /^00D[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;

// Only the first 15 chars identify the org, and they are case-sensitive.
const toOrgId15 = (orgId: string): string => orgId.slice(0, 15);

/** The host of an instance URL, or `undefined` when it does not parse. */
function hostOf(instanceUrl: string): string | undefined {
  try {
    return new URL(instanceUrl).hostname;
  } catch {
    return undefined;
  }
}

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
  // An instance URL is matched by its host, so a pasted URL must be too.
  const body = source
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
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

const TYPE_PREFIX = "type:";

function isTypeEntry(entry: string): boolean {
  return entry.slice(0, TYPE_PREFIX.length).toLowerCase() === TYPE_PREFIX;
}

/**
 * Read `--deny-orgs` into identity patterns and `type:` entries.
 *
 * Throws on a `type:` entry that names no org type, so a typo fails the server
 * at startup. An identity pattern cannot be validated this way - one that
 * matches nothing is indistinguishable from one that has yet to match.
 */
export function parseDenyOrgs(raw: string[]): {
  patterns: string[];
  types: OrgClassification[];
} {
  const entries = parseDenyOrgPatterns(raw);
  return {
    patterns: entries.filter((entry) => !isTypeEntry(entry)),
    types: entries.filter(isTypeEntry).map((entry) => {
      const type = entry.slice(TYPE_PREFIX.length).trim().toLowerCase();
      if (!isOrgClassification(type)) {
        throw new Error(
          `--deny-orgs: '${entry}' is not an org type. Use one of: ${ORG_CLASSIFICATIONS.map((t) => TYPE_PREFIX + t).join(", ")}.`,
        );
      }
      return type;
    }),
  };
}

/** Cleans its input, so a hand-built configuration behaves like a parsed one. */
export function compileDenyOrgs(sources: string[]): DenyPattern[] {
  return parseDenyOrgPatterns(sources).map(
    (source): DenyPattern =>
      ORG_ID.test(source)
        ? { source, kind: "orgId", orgId15: toOrgId15(source) }
        : { source, kind: "glob", regexp: compile(source) },
  );
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
    identity.instanceUrl && hostOf(identity.instanceUrl),
  ].filter((field): field is string => !!field);

  return patterns.find((pattern) =>
    pattern.kind === "orgId"
      ? pattern.orgId15 === toOrgId15(identity.orgId)
      : fields.some((field) => pattern.regexp.test(field)),
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
    `its type matches the --deny-orgs entry '${TYPE_PREFIX}${classification}'`,
  );
}
