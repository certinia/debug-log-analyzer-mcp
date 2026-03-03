/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

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

const mockOrgCreate = jest.fn() as jest.MockedFunction<any>;

const mockConfigAggregator = {
  getPropertyValue: jest.fn(),
} as any;

const mockConfigAggregatorCreate = jest.fn() as jest.MockedFunction<any>;

jest.mock("@salesforce/core", () => ({
  Org: {
    create: mockOrgCreate,
  },
  ConfigAggregator: {
    create: mockConfigAggregatorCreate,
  },
  OrgConfigProperties: {
    TARGET_ORG: "target-org",
  },
}));

import { connect } from "../../src/salesforce/connection";

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

  describe("connect", () => {
    it("should successfully connect with default org", async () => {
      const result = await connect();

      expect(mockConfigAggregatorCreate).toHaveBeenCalled();
      expect(mockConfigAggregator.getPropertyValue).toHaveBeenCalledWith(
        "target-org",
      );
      expect(mockOrgCreate).toHaveBeenCalledWith({
        aliasOrUsername: testUsername,
      });
      expect(result).toBe(mockConnectionInstance);
    });

    it("should throw error when no default org is configured", async () => {
      mockConfigAggregator.getPropertyValue.mockReturnValue(undefined);

      await expect(connect()).rejects.toThrow(noDefaultOrgError);
    });

    it("should use targetOrg when provided", async () => {
      const targetOrg = "my-scratch-org";
      const result = await connect(undefined, targetOrg);

      expect(mockConfigAggregatorCreate).not.toHaveBeenCalled();
      expect(mockOrgCreate).toHaveBeenCalledWith({
        aliasOrUsername: targetOrg,
      });
      expect(result).toBe(mockConnectionInstance);
    });

    it("should propagate errors from Org.create", async () => {
      const orgError = new Error("Org not found");
      mockOrgCreate.mockRejectedValue(orgError);

      await expect(connect()).rejects.toThrow("Org not found");
    });
  });
});
