import { Connection } from "jsforce";

export async function getUserIdByUsername(
  connection: Connection,
  username: string
): Promise<string> {
  const result = await connection.query(
    `SELECT Id FROM User WHERE Username = '${username}'`
  );

  if (result.records.length === 0) {
    throw new Error(`User not found with username: ${username}`);
  }

  const userId = result.records[0].Id;
  if (!userId) {
    throw new Error("User Id is undefined");
  }

  return userId;
}
