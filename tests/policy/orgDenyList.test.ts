/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  compileDenyOrgs,
  denyOrgRefusal,
  denyOrgTypeRefusal,
  matchDeniedOrg,
  parseDenyOrgPatterns,
  parseDenyOrgs,
  type OrgIdentity,
} from "../../src/policy/orgDenyList";

const identity: OrgIdentity = {
  orgId: "00D000000000001",
  username: "prod-eu-org@mycompany.com",
  alias: "euProd",
  instanceUrl: "https://acme.my.salesforce.com",
};

/** A config's worth of patterns, cleaned and compiled the way the server does. */
function deny(...patterns: string[]) {
  return compileDenyOrgs(parseDenyOrgPatterns(patterns));
}

describe("parseDenyOrgPatterns", () => {
  it("should split one comma-separated value", () => {
    expect(parseDenyOrgPatterns(["a@x.com,b@x.com"])).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  it("should gather a repeated flag", () => {
    expect(parseDenyOrgPatterns(["a@x.com", "b@x.com"])).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  it("should trim and drop empty values", () => {
    expect(parseDenyOrgPatterns([" a@x.com , ,b@x.com "])).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  // The refusal echoes this back, so it has to be what the user typed.
  it("should leave the case the user wrote", () => {
    expect(parseDenyOrgPatterns(["Prod-EU@Acme.com"])).toEqual([
      "Prod-EU@Acme.com",
    ]);
  });
});

describe("matchDeniedOrg", () => {
  it.each([
    ["org id", "00d000000000001"],
    ["username", "prod-eu-org@mycompany.com"],
    ["alias", "euprod"],
    ["instance URL", "https://acme.my.salesforce.com"],
  ])("should deny on an exact %s", (_field, pattern) => {
    expect(matchDeniedOrg(deny(pattern), identity)?.source).toBe(pattern);
  });

  it("should deny on a username glob", () => {
    expect(
      matchDeniedOrg(deny("prod-*-org@mycompany.com"), identity)?.source,
    ).toBe("prod-*-org@mycompany.com");
  });

  it("should deny on an instance URL glob", () => {
    expect(matchDeniedOrg(deny("*.my.salesforce.com"), identity)).toBeDefined();
  });

  it("should match whatever the case", () => {
    expect(matchDeniedOrg(deny("EUPROD"), identity)?.source).toBe("EUPROD");
  });

  // A configuration built by hand never passes through parseServerConfig, and
  // must not get a pattern that silently matches nothing.
  it("should clean a pattern that was not parsed from a flag", () => {
    expect(
      matchDeniedOrg(compileDenyOrgs([" euprod , other@x.com "]), identity)
        ?.source,
    ).toBe("euprod");
  });

  it("should anchor a glob, so it cannot match a longer name", () => {
    expect(
      matchDeniedOrg(deny("prod-*-org@mycompany.com"), {
        orgId: "00D000000000002",
        username: "xprod-eu-org@mycompany.com",
      }),
    ).toBeUndefined();
  });

  it("should read a dot as a dot and not as any character", () => {
    expect(
      matchDeniedOrg(deny("prod-eu-org@mycompany.com"), {
        orgId: "00D000000000002",
        username: "prod-eu-org@mycompanyxcom",
      }),
    ).toBeUndefined();
  });

  it("should read every other regex metacharacter literally", () => {
    const plus = { orgId: "00D000000000002", username: "a+b@x.com" };

    expect(matchDeniedOrg(deny("a+b@x.com"), plus)?.source).toBe("a+b@x.com");
    expect(matchDeniedOrg(deny("aab@x.com"), plus)).toBeUndefined();
  });

  it("should name the first pattern that matched", () => {
    expect(matchDeniedOrg(deny("nothing@x.com", "euprod"), identity)?.source).toBe(
      "euprod",
    );
  });

  it("should deny nothing when no pattern matches", () => {
    expect(matchDeniedOrg(deny("other@x.com"), identity)).toBeUndefined();
  });

  it("should deny nothing when no pattern is configured", () => {
    expect(matchDeniedOrg([], identity)).toBeUndefined();
  });

  it("should cope with an org that carries no alias or instance URL", () => {
    expect(
      matchDeniedOrg(deny("euprod"), {
        orgId: identity.orgId,
        username: identity.username,
      }),
    ).toBeUndefined();
  });
});

describe("parseDenyOrgs", () => {
  it("should split type: entries from identity patterns", () => {
    expect(
      parseDenyOrgs(["euprod,type:production", "type:unknown,*@x.com"]),
    ).toEqual({
      patterns: ["euprod", "*@x.com"],
      types: ["production", "unknown"],
    });
  });

  it("should read a type: entry whatever the case", () => {
    expect(parseDenyOrgs(["TYPE: Sandbox"]).types).toEqual(["sandbox"]);
  });

  it("should throw on a type: entry that is not an org type", () => {
    expect(() => parseDenyOrgs(["type:prodction"])).toThrow(
      "'type:prodction' is not an org type",
    );
  });

  it("should name the type: entries it accepts", () => {
    expect(() => parseDenyOrgs(["type:nope"])).toThrow(
      "type:sandbox, type:scratch, type:developer, type:trial, type:production, type:unknown",
    );
  });
});

describe("the deny refusals", () => {
  const pattern = deny("prod-*")[0]!;

  it("should name the pattern that matched", () => {
    expect(denyOrgRefusal("me@x.com", pattern)).toContain(
      "--deny-orgs pattern 'prod-*'",
    );
  });

  it("should name the type: entry that matched", () => {
    expect(denyOrgTypeRefusal("me@x.com", "production")).toContain(
      "--deny-orgs entry 'type:production'",
    );
  });

  it("should say that nothing lifts a deny", () => {
    expect(denyOrgRefusal("me@x.com", pattern)).toContain(
      "no flag and no confirmation lifts it",
    );
  });

  it("should not point at --allow-production-orgs, which cannot lift a deny", () => {
    expect(denyOrgRefusal("me@x.com", pattern)).not.toContain(
      "--allow-production-orgs",
    );
    expect(denyOrgTypeRefusal("me@x.com", "production")).not.toContain(
      "--allow-production-orgs",
    );
  });
});
