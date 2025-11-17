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

const mockLogin: any = jest.fn();
const mockConnectionInstance = {
  login: mockLogin,
};

jest.mock("jsforce", () => ({
  Connection: jest.fn().mockImplementation(() => mockConnectionInstance),
}));

jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

import { connect } from "../../src/salesforce/connection";
import { Connection } from "jsforce";

describe("Salesforce Connection", () => {
  const testUsername = "test@example.com";
  const testPassword = "password";
  const testSecurityToken = "token";
  const testLoginUrl = "https://test.salesforce.com";
  const missingEnvError =
    "Please set valid ORG_USERNAME, ORG_PASSWORD, ORG_SECURITY_TOKEN, and ORG_LOGIN_URL environment variables in your .env file";

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    mockLogin.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("connect", () => {
    it("should successfully connect with valid credentials", async () => {
      process.env.ORG_USERNAME = testUsername;
      process.env.ORG_PASSWORD = testPassword;
      process.env.ORG_SECURITY_TOKEN = testSecurityToken;
      process.env.ORG_LOGIN_URL = testLoginUrl;

      const result = await connect();

      expect(Connection).toHaveBeenCalledWith({
        loginUrl: testLoginUrl,
      });
      expect(mockLogin).toHaveBeenCalledWith(
        testUsername,
        testPassword + testSecurityToken
      );
      expect(result).toBe(mockConnectionInstance);
    });

    it("should throw error when ORG_USERNAME is missing", async () => {
      delete process.env.ORG_USERNAME;
      process.env.ORG_PASSWORD = testPassword;
      process.env.ORG_SECURITY_TOKEN = testSecurityToken;
      process.env.ORG_LOGIN_URL = testLoginUrl;

      await expect(connect()).rejects.toThrow(missingEnvError);
    });

    it("should throw error when ORG_PASSWORD is missing", async () => {
      process.env.ORG_USERNAME = testUsername;
      delete process.env.ORG_PASSWORD;
      process.env.ORG_SECURITY_TOKEN = testSecurityToken;
      process.env.ORG_LOGIN_URL = testLoginUrl;

      await expect(connect()).rejects.toThrow(missingEnvError);
    });

    it("should throw error when ORG_SECURITY_TOKEN is missing", async () => {
      process.env.ORG_USERNAME = testUsername;
      process.env.ORG_PASSWORD = testPassword;
      delete process.env.ORG_SECURITY_TOKEN;
      process.env.ORG_LOGIN_URL = testLoginUrl;

      await expect(connect()).rejects.toThrow(missingEnvError);
    });

    it("should throw error when ORG_LOGIN_URL is missing", async () => {
      process.env.ORG_USERNAME = testUsername;
      process.env.ORG_PASSWORD = testPassword;
      process.env.ORG_SECURITY_TOKEN = testSecurityToken;
      delete process.env.ORG_LOGIN_URL;

      await expect(connect()).rejects.toThrow(missingEnvError);
    });

    it("should handle login failure", async () => {
      process.env.ORG_USERNAME = testUsername;
      process.env.ORG_PASSWORD = testPassword;
      process.env.ORG_SECURITY_TOKEN = testSecurityToken;
      process.env.ORG_LOGIN_URL = testLoginUrl;

      const loginError = new Error("Invalid credentials");
      mockLogin.mockRejectedValue(loginError);

      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await expect(connect()).rejects.toThrow("Invalid credentials");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `Failed to connect to Salesforce: ${loginError}`
      );

      consoleErrorSpy.mockRestore();
    });

    it("should use correct login URL when provided", async () => {
      const customLoginUrl = "https://custom.salesforce.com";

      process.env.ORG_USERNAME = testUsername;
      process.env.ORG_PASSWORD = testPassword;
      process.env.ORG_SECURITY_TOKEN = testSecurityToken;
      process.env.ORG_LOGIN_URL = customLoginUrl;

      await connect();

      expect(Connection).toHaveBeenCalledWith({
        loginUrl: customLoginUrl,
      });
    });
  });
});
