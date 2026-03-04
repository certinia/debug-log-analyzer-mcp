/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { Connection } from "@salesforce/core";
import { getUserIdByUsername } from "../../src/salesforce/users";

describe("Users", () => {
  const testUserId = "000000000000000000";
  const testUsername = "test@example.com";

  let mockConnection: jest.Mocked<Connection>;
  let mockQuery: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();

    mockConnection = {
      query: mockQuery,
    } as any;
  });

  describe("getUserIdByUsername", () => {
    it("should return user ID when user is found", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
        ],
      });

      const result = await getUserIdByUsername(mockConnection, testUsername);

      expect(result).toBe(testUserId);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT Id FROM User WHERE Username = '${testUsername}'`,
      );
    });

    it("should throw error when user is not found", async () => {
      const username = "nonexistent@example.com";

      mockQuery.mockResolvedValue({
        records: [],
      });

      await expect(
        getUserIdByUsername(mockConnection, username),
      ).rejects.toThrow(`User not found with username: ${username}`);
    });

    it("should throw error when user ID is undefined", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: undefined,
          },
        ],
      });

      await expect(
        getUserIdByUsername(mockConnection, testUsername),
      ).rejects.toThrow("User Id is undefined");
    });

    it("should throw error when user ID is null", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: null,
          },
        ],
      });

      await expect(
        getUserIdByUsername(mockConnection, testUsername),
      ).rejects.toThrow("User Id is undefined");
    });

    it("should handle usernames with special characters", async () => {
      const username = "test+special@example.com";

      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
        ],
      });

      const result = await getUserIdByUsername(mockConnection, username);

      expect(result).toBe(testUserId);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT Id FROM User WHERE Username = '${username}'`,
      );
    });

    it("should escape single quotes in username to prevent SOQL injection", async () => {
      const username = "test'injection@example.com";

      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
        ],
      });

      const result = await getUserIdByUsername(mockConnection, username);

      expect(result).toBe(testUserId);
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT Id FROM User WHERE Username = 'test\\'injection@example.com'",
      );
    });

    it("should handle usernames with spaces", async () => {
      const username = "test user@example.com";

      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
        ],
      });

      const result = await getUserIdByUsername(mockConnection, username);

      expect(result).toBe(testUserId);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT Id FROM User WHERE Username = '${username}'`,
      );
    });

    it("should handle empty string username", async () => {
      const username = "";

      mockQuery.mockResolvedValue({
        records: [],
      });

      await expect(
        getUserIdByUsername(mockConnection, username),
      ).rejects.toThrow(`User not found with username: ${username}`);
    });

    it("should handle case-sensitive usernames", async () => {
      const username = "Test@Example.COM";

      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
        ],
      });

      const result = await getUserIdByUsername(mockConnection, username);

      expect(result).toBe(testUserId);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining(username));
    });

    it("should return first user when multiple users match", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
          {
            Id: "000000000000000001",
          },
        ],
      });

      const result = await getUserIdByUsername(mockConnection, testUsername);

      expect(result).toBe(testUserId);
    });

    it("should handle query errors gracefully", async () => {
      const queryError = new Error("Query failed");

      mockQuery.mockRejectedValue(queryError);

      await expect(
        getUserIdByUsername(mockConnection, testUsername),
      ).rejects.toThrow("Query failed");
    });

    it("should query using standard User object", async () => {
      mockQuery.mockResolvedValue({
        records: [
          {
            Id: testUserId,
          },
        ],
      });

      await getUserIdByUsername(mockConnection, testUsername);

      const queryCall = mockQuery.mock.calls[0][0];

      expect(queryCall).toContain("FROM User");
      expect(queryCall).toContain("SELECT Id");
      expect(queryCall).toContain("WHERE Username =");
    });
  });
});
