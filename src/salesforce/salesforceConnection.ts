import jsforce, { Connection } from "jsforce";
import env from "dotenv";

env.config();

const getUserDetails = () => {
  const orgUsername = process.env.ORG_USERNAME;
  const orgPassword = process.env.ORG_PASSWORD;
  const orgSecurityToken = process.env.ORG_SECURITY_TOKEN || "";

  if (
    !orgUsername ||
    !orgPassword ||
    orgUsername === "USERNAME" ||
    orgPassword === "PASSWORD"
  ) {
    throw new Error(
      "Please set valid ORG_USERNAME and ORG_PASSWORD environment variables in your .env file"
    );
  }

  return { orgUsername, orgPassword, orgSecurityToken };
};

export const connect = async (): Promise<Connection> => {
  const { orgUsername, orgPassword, orgSecurityToken } = getUserDetails();
  try {
    const connection = new Connection({
      loginUrl: "https://test.salesforce.com",
      accessToken: orgSecurityToken,
    });
    await connection.login(orgUsername, orgPassword + orgSecurityToken);
    return connection;
  } catch (error) {
    console.error("Failed to connect to Salesforce:", error);
    throw error;
  }
};

const sfC = await connect();

const res = await sfC.query("SELECT Id, Name FROM Account");

console.log(res);
