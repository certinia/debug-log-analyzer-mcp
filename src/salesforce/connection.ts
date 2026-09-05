// First, so the guard runs before the SDK below is evaluated. Both modules that
// call the SDK carry it: whichever is reached first must set it.
import "./logging.js";
// This module calls the SDK, so it is reached only through an `await import()`.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { ConfigAggregator, OrgConfigProperties, Org } from "@salesforce/core";

export async function resolveOrg(
  projectPath?: string,
  targetOrg?: string,
): Promise<Org> {
  const aliasOrUsername = targetOrg ?? (await resolveDefaultOrg(projectPath));
  return Org.create({ aliasOrUsername });
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
