import "./logging.js";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  AuthInfo,
  ConfigAggregator,
  Connection,
  OrgConfigProperties,
  Org,
  StateAggregator,
} from "@salesforce/core";

/** The target org as the local sf files know it. */
export type LocalOrg = {
  orgId: string;
  username: string;
  aliases: string[];
  instanceUrl?: string;
  authInfo: AuthInfo;
};

/**
 * Read the target org from the local config, alias and auth files.
 *
 * Unlike `Org.create`, which can call the org for its API version and its
 * edition, this never leaves the machine - so a denied org is refused unseen.
 */
export async function readLocalOrg(
  projectPath?: string,
  targetOrg?: string,
): Promise<LocalOrg> {
  const aliasOrUsername = targetOrg ?? (await resolveDefaultOrg(projectPath));
  const { aliases } = await StateAggregator.getInstance();
  const username = aliases.resolveUsername(aliasOrUsername);
  const authInfo = await AuthInfo.create({ username });
  const { orgId, instanceUrl } = authInfo.getFields();

  if (!orgId) {
    throw new Error(`The auth file for '${username}' holds no org id.`);
  }

  return {
    orgId,
    username,
    aliases: aliases.getAll(username),
    instanceUrl,
    authInfo,
  };
}

/** Connect through the auth `readLocalOrg` read, so it is the org it checked. */
export async function connectOrg(local: LocalOrg): Promise<Org> {
  return Org.create({
    connection: await Connection.create({ authInfo: local.authInfo }),
  });
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
