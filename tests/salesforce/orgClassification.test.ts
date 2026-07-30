/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Org } from "@salesforce/core";
import {
  classifyOrganization,
  classifyOrg,
  type OrgClassification,
  type OrganizationRecord,
} from "../../src/salesforce/orgClassification";

const base: OrganizationRecord = {
  IsSandbox: false,
  TrialExpirationDate: null,
  OrganizationType: "Enterprise Edition",
};

describe("classifyOrganization", () => {
  it("should classify a sandbox", () => {
    expect(classifyOrganization({ ...base, IsSandbox: true })).toBe("sandbox");
  });

  it("should classify a scratch org as scratch, not sandbox", () => {
    // Scratch orgs are sandboxes that carry a trial expiry.
    expect(
      classifyOrganization({
        ...base,
        IsSandbox: true,
        TrialExpirationDate: "2026-12-31T00:00:00.000+0000",
      }),
    ).toBe("scratch");
  });

  it("should classify a non-sandbox org with a trial expiry as a trial", () => {
    expect(
      classifyOrganization({
        ...base,
        TrialExpirationDate: "2026-12-31T00:00:00.000+0000",
      }),
    ).toBe("trial");
  });

  it("should classify a Developer Edition org as developer", () => {
    expect(
      classifyOrganization({ ...base, OrganizationType: "Developer Edition" }),
    ).toBe("developer");
  });

  it("should classify a paid edition as production", () => {
    expect(classifyOrganization(base)).toBe("production");
    expect(
      classifyOrganization({ ...base, OrganizationType: "Unlimited Edition" }),
    ).toBe("production");
  });

  it("should fail closed on an unrecognised organization type", () => {
    expect(
      classifyOrganization({ ...base, OrganizationType: "Some Future Edition" }),
    ).toBe("production");
  });

  it("should treat an empty organization type as production", () => {
    expect(classifyOrganization({ ...base, OrganizationType: "" })).toBe(
      "production",
    );
  });
});

describe("classifyOrg", () => {
  const orgId = "00D000000000001";
  let cache: Map<string, OrgClassification>;
  let retrieve: jest.Mock;
  let org: Org;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    cache = new Map();
    retrieve = jest.fn().mockResolvedValue({ ...base, IsSandbox: true });
    org = {
      getOrgId: () => orgId,
      retrieveOrganizationInformation: retrieve,
    } as unknown as Org;
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("should classify from the Organization record", async () => {
    await expect(classifyOrg(org, cache)).resolves.toEqual({
      classification: "sandbox",
    });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("should query only once per org", async () => {
    await classifyOrg(org, cache);
    await classifyOrg(org, cache);
    await classifyOrg(org, cache);

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(cache.get(orgId)).toBe("sandbox");
  });

  it("should query again for a different org", async () => {
    const other = {
      getOrgId: () => "00D000000000002",
      retrieveOrganizationInformation: retrieve,
    } as unknown as Org;

    await classifyOrg(org, cache);
    await classifyOrg(other, cache);

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it("should report why the org could not be queried", async () => {
    retrieve.mockRejectedValue(
      new Error("Unable to refresh session due to: inactive organization"),
    );

    await expect(classifyOrg(org, cache)).resolves.toEqual({
      classification: "unknown",
      unverifiedReason:
        "Unable to refresh session due to: inactive organization",
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it("should handle a non-Error rejection", async () => {
    retrieve.mockRejectedValue("boom");

    await expect(classifyOrg(org, cache)).resolves.toEqual({
      classification: "unknown",
      unverifiedReason: "boom",
    });
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), "boom");
  });

  it("should not cache a failure, so a transient error is retried", async () => {
    retrieve.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(classifyOrg(org, cache)).resolves.toEqual({
      classification: "unknown",
      unverifiedReason: "ECONNRESET",
    });
    expect(cache.size).toBe(0);

    await expect(classifyOrg(org, cache)).resolves.toEqual({
      classification: "sandbox",
    });
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
