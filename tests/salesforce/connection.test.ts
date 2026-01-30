/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
} from "@jest/globals";

const mockConnectionInstance = {
  query: jest.fn(),
  tooling: {
    query: jest.fn(),
    executeAnonymous: jest.fn(),
  },
} as any;

const mockAuthInfo = {
  create: jest.fn(),
} as any;

const mockConnectionCreate = jest.fn() as jest.MockedFunction<any>;

const mockConfigAggregator = {
  getPropertyValue: jest.fn(),
} as any;

const mockConfigAggregatorCreate = jest.fn() as jest.MockedFunction<any>;

jest.mock("@salesforce/core", () => ({
  Connection: {
    create: mockConnectionCreate,
  },
  AuthInfo: {
    create: mockAuthInfo.create,
  },
  ConfigAggregator: {
    create: mockConfigAggregatorCreate,
  },
}));

import { connect } from "../../src/salesforce/connection";

describe("Salesforce Connection", () => {
  const testUsername = "test@example.com";
  const noDefaultOrgError =
    "No default org configured. Please set a default org using 'sf config set target-org <username>'.";

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthInfo.create.mockResolvedValue({ username: testUsername });
    mockConnectionCreate.mockResolvedValue(mockConnectionInstance);
    mockConfigAggregatorCreate.mockResolvedValue(mockConfigAggregator);
    mockConfigAggregator.getPropertyValue.mockReturnValue(testUsername);
  });

  describe("connect", () => {
    it("should successfully connect with default org", async () => {
      const result = await connect();

      expect(mockConfigAggregatorCreate).toHaveBeenCalled();
      expect(mockConfigAggregator.getPropertyValue).toHaveBeenCalledWith("target-org");
      expect(mockAuthInfo.create).toHaveBeenCalledWith({
        username: testUsername,
      });
      expect(mockConnectionCreate).toHaveBeenCalled();
      expect(result).toBe(mockConnectionInstance);
    });

    it("should throw error when no default org is configured", async () => {
      mockConfigAggregator.getPropertyValue.mockReturnValue(undefined);

      await expect(connect()).rejects.toThrow(noDefaultOrgError);
    });

    it("should propagate errors from AuthInfo.create", async () => {
      const authError = new Error("Org not found");
      mockAuthInfo.create.mockRejectedValue(authError);

      await expect(connect()).rejects.toThrow("Org not found");
    });
  });
});
