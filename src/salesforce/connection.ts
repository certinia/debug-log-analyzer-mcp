import { Connection, AuthInfo } from "@salesforce/core";
import env from "dotenv";

env.config();

function getUserDetails() {
  const orgUsername = process.env.ORG_USERNAME;

  if (!orgUsername) {
    throw new Error(
      "Please set a valid ORG_USERNAME environment variable in your .env file"
    );
  }

  return orgUsername;
}

export async function connect(): Promise<Connection> {
  const orgUsername = getUserDetails();

  const authInfo = await AuthInfo.create({ username: orgUsername });
  const connection = await Connection.create({ authInfo });

  return connection;
}
