import { Connection } from "jsforce";
import env from "dotenv";

env.config();

const getUserDetails = () => {
  const orgUsername = process.env.ORG_USERNAME;
  const orgPassword = process.env.ORG_PASSWORD;
  const orgSecurityToken = process.env.ORG_SECURITY_TOKEN || "";
  const orgLoginUrl = process.env.ORG_LOGIN_URL || "";

  if (!orgUsername || !orgPassword || !orgSecurityToken) {
    throw new Error(
      "Please set valid ORG_USERNAME, ORG_PASSWORD and ORG_SECURITY_TOKEN environment variables in your .env file"
    );
  }

  const passwordWithToken = orgPassword + orgSecurityToken;

  return { orgUsername, orgPassword: passwordWithToken, orgLoginUrl };
};

export const connect = async (): Promise<Connection> => {
  const { orgUsername, orgPassword, orgLoginUrl } = getUserDetails();
  try {
    const connection = new Connection({
      loginUrl: orgLoginUrl,
    });
    await connection.login(orgUsername, orgPassword);
    return connection;
  } catch (error) {
    console.error("Failed to connect to Salesforce:", error);
    throw error;
  }
};
