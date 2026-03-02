import {
  Connection,
  ConfigAggregator,
  OrgConfigProperties,
  Org,
} from "@salesforce/core";

export async function connect(
  projectPath?: string,
  targetOrg?: string,
): Promise<Connection> {
  const aliasOrUsername = targetOrg ?? (await resolveDefaultOrg(projectPath));
  const org = await Org.create({ aliasOrUsername });
  return org.getConnection();
}

async function resolveDefaultOrg(projectPath?: string): Promise<string> {
  const aggregator = await ConfigAggregator.create({ projectPath });
  const defaultOrg = aggregator.getPropertyValue<string>(
    OrgConfigProperties.TARGET_ORG,
  );

  if (!defaultOrg) {
    throw new Error(
      "No default org configured. Please set a default org using 'sf config set target-org <username>' (use --global if not in a Salesforce DX project).",
    );
  }

  return defaultOrg;
}
