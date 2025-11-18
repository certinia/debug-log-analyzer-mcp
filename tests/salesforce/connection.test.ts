/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
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

jest.mock("@salesforce/core", () => ({
  Connection: {
    create: mockConnectionCreate,
  },
  AuthInfo: {
    create: mockAuthInfo.create,
  },
}));

jest.mock("dotenv", () => {
  const mockConfig = jest.fn();
  return {
    default: mockConfig,
    config: mockConfig,
  };
});

import { connect } from "../../src/salesforce/connection";

describe("Salesforce Connection", () => {
  const testUsername = "test@example.com";
  const missingUsernameError =
    "Please set a valid ORG_USERNAME environment variable in your .env file";

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    mockAuthInfo.create.mockResolvedValue({ username: testUsername });
    mockConnectionCreate.mockResolvedValue(mockConnectionInstance);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("connect", () => {
    it("should successfully connect with valid username", async () => {
      process.env.ORG_USERNAME = testUsername;

      const result = await connect();

      expect(mockAuthInfo.create).toHaveBeenCalledWith({
        username: testUsername,
      });
      expect(mockConnectionCreate).toHaveBeenCalled();
      expect(result).toBe(mockConnectionInstance);
    });

    it("should throw error when ORG_USERNAME is missing", async () => {
      delete process.env.ORG_USERNAME;

      await expect(connect()).rejects.toThrow(missingUsernameError);
    });

    it("should propagate errors from AuthInfo.create", async () => {
      process.env.ORG_USERNAME = testUsername;
      const authError = new Error("Org not found");
      mockAuthInfo.create.mockRejectedValue(authError);

      await expect(connect()).rejects.toThrow("Org not found");
    });
  });
});
