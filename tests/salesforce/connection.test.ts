/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

jest.mock("@salesforce/core", () => ({
  AuthInfo: {
    create: jest.fn(),
  },
  Connection: {
    create: jest.fn(),
  },
  StateAggregator: {
    getInstance: jest.fn(),
  },
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

import {
  AuthInfo,
  ConfigAggregator,
  Connection,
  Org,
  StateAggregator,
} from "@salesforce/core";
import { connectOrg, readLocalOrg } from "../../src/salesforce/connection";

const mockOrgCreate = Org.create as jest.MockedFunction<typeof Org.create>;
const mockConfigAggregatorCreate =
  ConfigAggregator.create as jest.MockedFunction<
    typeof ConfigAggregator.create
  >;

const mockConnectionInstance = { tooling: {} } as any;
const mockOrgInstance = {} as any;

const mockConfigAggregator = {
  getPropertyValue: jest.fn(),
} as any;

const aliases = {
  resolveUsername: jest.fn((name: string) =>
    name === "prod" ? "test@example.com" : name,
  ),
  getAll: jest.fn(() => ["myprod", "prod"]),
};
const getFields = jest.fn(() => ({
  orgId: "00D5g000004XyZaEAK",
  instanceUrl: "https://acme.my.salesforce.com",
}));
const mockAuthInfo = { getFields } as any;

describe("Salesforce Connection", () => {
  const testUsername = "test@example.com";
  const noDefaultOrgError =
    "No default org configured. Please set a default org using 'sf config set target-org <username>'";

  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgCreate.mockResolvedValue(mockOrgInstance);
    mockConfigAggregatorCreate.mockResolvedValue(mockConfigAggregator);
    mockConfigAggregator.getPropertyValue.mockReturnValue(testUsername);
    (StateAggregator.getInstance as jest.Mock).mockResolvedValue({ aliases });
    (AuthInfo.create as jest.Mock).mockResolvedValue(mockAuthInfo);
    (Connection.create as jest.Mock).mockResolvedValue(mockConnectionInstance);
  });

  describe("readLocalOrg", () => {
    it("should read the org from the local files, never the org", async () => {
      await expect(readLocalOrg(undefined, "prod")).resolves.toEqual({
        orgId: "00D5g000004XyZaEAK",
        username: testUsername,
        aliases: ["myprod", "prod"],
        instanceUrl: "https://acme.my.salesforce.com",
        authInfo: mockAuthInfo,
      });
      expect(AuthInfo.create).toHaveBeenCalledWith({ username: testUsername });
      expect(mockConfigAggregatorCreate).not.toHaveBeenCalled();
      expect(Connection.create).not.toHaveBeenCalled();
      expect(mockOrgCreate).not.toHaveBeenCalled();
    });

    it("should fall back to the default org", async () => {
      const local = await readLocalOrg();

      expect(local.username).toBe(testUsername);
      expect(mockConfigAggregator.getPropertyValue).toHaveBeenCalledWith(
        "target-org",
      );
    });

    it("should throw error when no default org is configured", async () => {
      mockConfigAggregator.getPropertyValue.mockReturnValue(undefined);

      await expect(readLocalOrg()).rejects.toThrow(noDefaultOrgError);
    });

    it("should throw when the auth file holds no org id", async () => {
      getFields.mockReturnValueOnce({ orgId: undefined } as never);

      await expect(readLocalOrg(undefined, "prod")).rejects.toThrow(
        "holds no org id",
      );
    });
  });

  describe("connectOrg", () => {
    it("should connect through the auth readLocalOrg read", async () => {
      const local = await readLocalOrg(undefined, "prod");

      await expect(connectOrg(local)).resolves.toBe(mockOrgInstance);
      expect(Connection.create).toHaveBeenCalledWith({
        authInfo: mockAuthInfo,
      });
      expect(mockOrgCreate).toHaveBeenCalledWith({
        connection: mockConnectionInstance,
      });
    });

    it("should propagate errors from Org.create", async () => {
      mockOrgCreate.mockRejectedValue(new Error("Org not found"));

      await expect(
        connectOrg(await readLocalOrg(undefined, "prod")),
      ).rejects.toThrow("Org not found");
    });
  });
});
