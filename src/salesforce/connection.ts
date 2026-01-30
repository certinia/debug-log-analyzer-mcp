import { Connection, AuthInfo, ConfigAggregator } from "@salesforce/core";

export async function connect(): Promise<Connection> {
  // Get default org from SF CLI configuration
  const aggregator = await ConfigAggregator.create();
  const defaultOrg = aggregator.getPropertyValue("target-org") as string | undefined;

  if (!defaultOrg) {
    throw new Error(
      "No default org configured. Please set a default org using 'sf config set target-org <username>'."
    );
  }

  const authInfo = await AuthInfo.create({ username: defaultOrg });
  const connection = await Connection.create({ authInfo });

  return connection;
}
