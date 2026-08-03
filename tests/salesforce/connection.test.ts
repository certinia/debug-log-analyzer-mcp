/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("@salesforce/core", () => ({
  Org: {
    create: jest.fn(),
  },
  ConfigAggregator: {
    create: jest.fn(),
  },
  OrgConfigProperties: {
    TARGET_ORG: "target-org",
  },
}));

import { Org, ConfigAggregator } from "@salesforce/core";
import { resolveOrg } from "../../src/salesforce/connection";

const mockOrgCreate = Org.create as jest.MockedFunction<typeof Org.create>;
const mockConfigAggregatorCreate =
  ConfigAggregator.create as jest.MockedFunction<
    typeof ConfigAggregator.create
  >;

const mockConnectionInstance = {
  query: jest.fn(),
  tooling: {
    query: jest.fn(),
    executeAnonymous: jest.fn(),
  },
} as any;

const mockOrgInstance = {
  getConnection: jest.fn().mockReturnValue(mockConnectionInstance),
} as any;

const mockConfigAggregator = {
  getPropertyValue: jest.fn(),
} as any;

describe("Salesforce Connection", () => {
  const testUsername = "test@example.com";
  const noDefaultOrgError =
    "No default org configured. Please set a default org using 'sf config set target-org <username>'";

  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgCreate.mockResolvedValue(mockOrgInstance);
    mockConfigAggregatorCreate.mockResolvedValue(mockConfigAggregator);
    mockConfigAggregator.getPropertyValue.mockReturnValue(testUsername);
  });

  describe("resolveOrg", () => {
    it("should successfully connect with default org", async () => {
      const result = await resolveOrg();

      expect(mockConfigAggregatorCreate).toHaveBeenCalled();
      expect(mockConfigAggregator.getPropertyValue).toHaveBeenCalledWith(
        "target-org",
      );
      expect(mockOrgCreate).toHaveBeenCalledWith({
        aliasOrUsername: testUsername,
      });
      expect(result).toBe(mockOrgInstance);
    });

    it("should throw error when no default org is configured", async () => {
      mockConfigAggregator.getPropertyValue.mockReturnValue(undefined);

      await expect(resolveOrg()).rejects.toThrow(noDefaultOrgError);
    });

    it("should use targetOrg when provided", async () => {
      const targetOrg = "my-scratch-org";
      const result = await resolveOrg(undefined, targetOrg);

      expect(mockConfigAggregatorCreate).not.toHaveBeenCalled();
      expect(mockOrgCreate).toHaveBeenCalledWith({
        aliasOrUsername: targetOrg,
      });
      expect(result).toBe(mockOrgInstance);
    });

    it("should propagate errors from Org.create", async () => {
      const orgError = new Error("Org not found");
      mockOrgCreate.mockRejectedValue(orgError);

      await expect(resolveOrg()).rejects.toThrow("Org not found");
    });
  });
});
