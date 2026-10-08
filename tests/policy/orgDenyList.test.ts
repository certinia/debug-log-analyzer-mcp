/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  compileDenyList,
  denyRefusal,
  identityRefusal,
  matchDeniedOrg,
  typeRefusal,
  type OrgIdentity,
} from "../../src/policy/orgDenyList";

// The auth file holds the 18-char id.
const identity: OrgIdentity = {
  orgId: "00D5g000004XyZaEAK",
  username: "prod-eu-org@mycompany.com",
  aliases: ["euProd"],
  instanceUrl: "https://acme.my.salesforce.com",
};

/** A config's identity patterns, compiled the way the server does. */
function deny(...patterns: string[]) {
  return compileDenyList(patterns).patterns;
}

const sources = (raw: string[]) =>
  compileDenyList(raw).patterns.map((pattern) => pattern.source);

describe("compileDenyList", () => {
  it("should split one comma-separated value", () => {
    expect(sources(["a@x.com,b@x.com"])).toEqual(["a@x.com", "b@x.com"]);
  });

  it("should gather a repeated flag", () => {
    expect(sources(["a@x.com", "b@x.com"])).toEqual(["a@x.com", "b@x.com"]);
  });

  it("should trim and drop empty values", () => {
    expect(sources([" a@x.com , ,b@x.com "])).toEqual(["a@x.com", "b@x.com"]);
  });

  // The refusal echoes this back, so it has to be what the user typed.
  it("should leave the case the user wrote", () => {
    expect(sources(["Prod-EU@Acme.com"])).toEqual(["Prod-EU@Acme.com"]);
  });

  it("should split type: entries from identity patterns", () => {
    const list = compileDenyList([
      "euprod,type:production",
      "type:unknown,*@x.com",
    ]);

    expect(list.patterns.map((pattern) => pattern.source)).toEqual([
      "euprod",
      "*@x.com",
    ]);
    expect(list.types).toEqual(["production", "unknown"]);
  });

  it("should read a type: entry whatever the case", () => {
    expect(compileDenyList(["TYPE: Sandbox"]).types).toEqual(["sandbox"]);
  });

  it("should throw on a type: entry that is not an org type", () => {
    expect(() => compileDenyList(["type:prodction"])).toThrow(
      "'type:prodction' is not an org type",
    );
  });

  it("should name the type: entries it accepts", () => {
    expect(() => compileDenyList(["type:nope"])).toThrow(
      "type:sandbox, type:scratch, type:developer, type:trial, type:production, type:unknown",
    );
  });
});

describe("matchDeniedOrg", () => {
  it.each([
    ["15-char org id", "00D5g000004XyZa"],
    ["18-char org id", "00D5g000004XyZaEAK"],
    ["username", "prod-eu-org@mycompany.com"],
    ["alias", "euprod"],
    ["instance host", "acme.my.salesforce.com"],
    ["instance URL", "https://acme.my.salesforce.com/"],
    ["pasted URL", "https://acme.my.salesforce.com:443/lightning/page/home"],
  ])("should deny on an exact %s", (_field, pattern) => {
    expect(matchDeniedOrg(deny(pattern), identity)?.source).toBe(pattern);
  });

  // A miss lets the Apex run, so case may only widen a deny, never narrow it.
  it.each([
    ["an 18-char id", "00D5G000004XYZAEAK"],
    ["a 15-char id", "00d5g000004xyza"],
  ])("should deny on %s in another case", (_form, pattern) => {
    expect(matchDeniedOrg(deny(pattern), identity)?.source).toBe(pattern);
  });

  it("should match an id on its first 15 chars, not as a glob of 18", () => {
    expect(
      matchDeniedOrg(deny("00D5g000004XyZaZZZ"), identity)?.source,
    ).toBe("00D5g000004XyZaZZZ");
  });

  it("should not deny on an org id that only shares the prefix", () => {
    expect(matchDeniedOrg(deny("00D5g000004XyZb"), identity)).toBeUndefined();
  });

  it("should deny on a username glob", () => {
    expect(
      matchDeniedOrg(deny("prod-*-org@mycompany.com"), identity)?.source,
    ).toBe("prod-*-org@mycompany.com");
  });

  it("should deny every sandbox of a My Domain on a host glob", () => {
    const sandbox = {
      ...identity,
      username: "me@acme.com.uat",
      instanceUrl: "https://acme--uat.sandbox.my.salesforce.com",
    };

    expect(matchDeniedOrg(deny("acme--*"), sandbox)?.source).toBe("acme--*");
    expect(matchDeniedOrg(deny("acme--uat.*"), sandbox)).toBeDefined();
    expect(matchDeniedOrg(deny("acme--*"), identity)).toBeUndefined();
  });

  it("should match whatever the case", () => {
    expect(matchDeniedOrg(deny("EUPROD"), identity)?.source).toBe("EUPROD");
  });

  it("should anchor a glob, so it cannot match a longer name", () => {
    expect(
      matchDeniedOrg(deny("prod-*-org@mycompany.com"), {
        ...identity,
        username: "xprod-eu-org@mycompany.com",
      }),
    ).toBeUndefined();
  });

  it("should read a dot as a dot and not as any character", () => {
    expect(
      matchDeniedOrg(deny("prod-eu-org@mycompany.com"), {
        ...identity,
        username: "prod-eu-org@mycompanyxcom",
      }),
    ).toBeUndefined();
  });

  it("should read every other regex metacharacter literally", () => {
    const plus = {
      ...identity,
      username: "a+b@x.com",
    };

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
        aliases: [],
      }),
    ).toBeUndefined();
  });

  it("should deny on any alias, not only the first", () => {
    expect(
      matchDeniedOrg(deny("prod"), { ...identity, aliases: ["myprod", "prod"] })
        ?.source,
    ).toBe("prod");
  });
});

const action = "execute anonymous Apex";

describe("identityRefusal and typeRefusal", () => {
  const list = compileDenyList(["euprod", "type:production"]);

  it("should refuse on an identity entry", () => {
    expect(identityRefusal(list, action, "me", identity)).toContain(
      "--deny-orgs entry 'euprod'",
    );
  });

  // A type: entry needs the org classified, so only typeRefusal reads it.
  it("should leave a type: entry to typeRefusal", () => {
    const other = { ...identity, username: "x@y.com", aliases: [] };

    expect(identityRefusal(list, action, "me", other)).toBeUndefined();
    expect(typeRefusal(list, action, "me", "production")).toContain(
      "--deny-orgs entry 'type:production'",
    );
  });

  it("should refuse no type the list does not name", () => {
    expect(typeRefusal(list, action, "me", "sandbox")).toBeUndefined();
  });

  it("should deny an org of unknown type under type:production", () => {
    const refusal = typeRefusal(list, action, "me", "unknown");

    expect(refusal).toContain("its type could not be read");
    expect(refusal).toContain("--deny-orgs entry 'type:production'");
  });

  it("should not deny an org of unknown type without type:production", () => {
    expect(
      typeRefusal(compileDenyList(["type:sandbox"]), action, "me", "unknown"),
    ).toBeUndefined();
  });
});

describe("denyRefusal", () => {
  const refusal = denyRefusal(action, "me@x.com", "prod-*");

  it("should build the refusal from the action", () => {
    expect(refusal).toMatch(/^Cannot execute anonymous Apex against org 'me@x.com': /);
  });

  it("should name the entry that matched", () => {
    expect(refusal).toContain("--deny-orgs entry 'prod-*'");
  });

  it("should say that nothing lifts a deny", () => {
    expect(refusal).toContain("no flag and no confirmation lifts it");
  });

  it("should not point at --allow-production-orgs, which cannot lift a deny", () => {
    expect(refusal).not.toContain("--allow-production-orgs");
  });
});
