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

/** `--deny-orgs` refuses every org tool; `--deny-org-writes` only the tools that change an org. */
export type DenyFlag = "--deny-orgs" | "--deny-org-writes";

/**
 * A deny flag, compiled: identity patterns, and the `type:` entries.
 *
 * Typed by its flag, so a list cannot be held where the other flag's scope is enforced.
 */
export type DenyList<F extends DenyFlag = DenyFlag> = {
  /** The flag the entries came from, so a refusal names the one the user set. */
  flag: F;
  patterns: DenyPattern[];
  types: OrgClassification[];
};

/**
 * What is known about the target org before it is queried.
 *
 * Every field comes from the local sf files, so a deny is decided without
 * contacting the org. Only `orgId` is unspoofable - an alias can be re-pointed
 * at another org - so the rest are a convenience, not a security boundary.
 */
export type OrgIdentity = {
  orgId: string;
  username: string;
  /** Every alias of the username, so a deny on any one of them holds. */
  aliases: string[];
  instanceUrl?: string;
};

/** Every character `RegExp` reads as syntax, less `*`, which is the glob. */
const REGEXP_METACHARACTERS = /[.+?^${}()|[\]\\]/g;

/** An org id: 15 chars as Setup shows it, or 18 as the auth file holds it. */
const ORG_ID = /^00D[a-z0-9]{12}(?:[a-z0-9]{3})?$/i;

const TYPE_ENTRY = /^type:/i;

const DENY_IS_ABSOLUTE =
  "A deny is absolute: no flag and no confirmation lifts it.";

/**
 * What the agent can do next, by flag.
 *
 * A write deny states its own scope, so the agent does not give up reading the
 * org. It does not say reads work: a `--deny-orgs` `type:` entry, checked only
 * after connecting, can still refuse them.
 */
const NEXT_STEP: Record<DenyFlag, string> = {
  "--deny-orgs": "Ask the user which org to use.",
  "--deny-org-writes":
    "--deny-org-writes refuses only tools that change an org; to change one, ask the user which org to use.",
};

// The 18-char suffix only encodes the case of the first 15.
const toOrgId15 = (orgId: string): string => orgId.slice(0, 15);

// A regex and not `URL`, because a pattern may hold a `*`.
const toHost = (value: string): string =>
  value.replace(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]*).*$/i, "$1");

// Ignoring case can only over-deny; a cased miss would let a run through.
function compile(source: string): RegExp {
  const body = toHost(ORG_ID.test(source) ? toOrgId15(source) : source)
    .split("*")
    .map((literal) => literal.replace(REGEXP_METACHARACTERS, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

function toOrgType(flag: DenyFlag, entry: string): OrgClassification {
  const type = entry.replace(TYPE_ENTRY, "").trim().toLowerCase();
  if (!isOrgClassification(type)) {
    throw new Error(
      `${flag}: '${entry}' is not an org type. Use one of: ${ORG_CLASSIFICATIONS.map((t) => `type:${t}`).join(", ")}.`,
    );
  }
  return type;
}

/**
 * Compile a deny flag, which is repeatable and comma-separated.
 *
 * Throws on a `type:` entry that names no org type, so a typo fails the server
 * at startup. An identity pattern cannot be validated this way - one that
 * matches nothing is indistinguishable from one that has yet to match.
 *
 * Case is left as written, because a refusal has to echo the entry the user
 * typed.
 */
export function compileDenyList<F extends DenyFlag>(
  raw: string[],
  flag: F,
): DenyList<F> {
  const entries = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    flag,
    patterns: entries
      .filter((entry) => !TYPE_ENTRY.test(entry))
      .map((source) => ({ source, regexp: compile(source) })),
    types: entries
      .filter((entry) => TYPE_ENTRY.test(entry))
      .map((entry) => toOrgType(flag, entry)),
  };
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
    toOrgId15(identity.orgId),
    identity.username,
    ...identity.aliases,
    identity.instanceUrl && toHost(identity.instanceUrl),
  ].filter((field): field is string => !!field);

  return patterns.find((pattern) =>
    fields.some((field) => pattern.regexp.test(field)),
  );
}

function refusal(
  flag: DenyFlag,
  action: string,
  orgLabel: string,
  because: string,
): string {
  return `Cannot ${action} against org '${orgLabel}': ${because}.\n${DENY_IS_ABSOLUTE} ${NEXT_STEP[flag]}`;
}

/** The refusal naming the entry of `flag` that denies the org. */
function denyRefusal(
  flag: DenyFlag,
  action: string,
  orgLabel: string,
  entry: string,
): string {
  return refusal(
    flag,
    action,
    orgLabel,
    `it matches the ${flag} entry '${entry}'`,
  );
}

/** The refusal when an identity entry denies this org, or `undefined`. */
export function identityRefusal(
  list: DenyList,
  action: string,
  orgLabel: string,
  identity: OrgIdentity,
): string | undefined {
  const pattern = matchDeniedOrg(list.patterns, identity);
  return pattern && denyRefusal(list.flag, action, orgLabel, pattern.source);
}

/** The refusal when a `type:` entry denies this org type, or `undefined`. */
export function typeRefusal(
  list: DenyList,
  action: string,
  orgLabel: string,
  classification: OrgClassification,
): string | undefined {
  if (list.types.includes(classification)) {
    return denyRefusal(list.flag, action, orgLabel, `type:${classification}`);
  }
  // Unknown is treated as production everywhere; it must not slip past this deny.
  if (classification === "unknown" && list.types.includes("production")) {
    return refusal(
      list.flag,
      action,
      orgLabel,
      `its type could not be read, so it is treated as production and the ${list.flag} entry 'type:production' denies it`,
    );
  }
  return undefined;
}
