/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

/**
 * Resolves the npm dist-tag for a release, and refuses the release when the git
 * tag, the version in package.json and the GitHub pre-release flag disagree.
 *
 * `latest` is a pointer, not "the highest version". `npm install`, `npm install
 * pkg@latest` and `npx pkg` all follow it, and `pnpm publish` moves it to
 * whatever was just published unless `--tag` says otherwise. The VS Code
 * extension starts this server through `npx`, so a prerelease published without
 * a tag reaches every user on their next run — and the pointer can only be put
 * back by publishing again. That is what this script exists to prevent.
 *
 * The prerelease identifier chooses the dist-tag, so `2.0.0-beta.1` publishes
 * under `beta` and is installed with `@certinia/apex-log-mcp@beta`. Only the
 * three identifiers below are accepted: any other one would silently create a
 * dist-tag that no user would think to ask for.
 *
 * Inputs, from the environment:
 *   RELEASE_TAG    the git tag of the release, with or without a leading `v`
 *   PRERELEASE     `true` when the GitHub release is marked as a pre-release
 *   GITHUB_OUTPUT  the step output file; when unset the result only goes to
 *                  stdout, so this can be run by hand before tagging
 *
 * package.json is read from the working directory.
 *
 * Output: `dist_tag=<alpha|beta|rc|latest>`
 *
 * Usage:
 *   RELEASE_TAG=v2.0.0-beta.1 PRERELEASE=true node scripts/release-tag.mjs
 */

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The prerelease identifiers that may become a dist-tag. `latest` is not one of
 * them: it is the stable pointer, and a `2.0.0-latest.1` would overwrite it.
 */
const PRERELEASE_DIST_TAGS = ["alpha", "beta", "rc"];

const VERSION =
  /^\d+\.\d+\.\d+(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Prints a GitHub Actions error annotation and stops. */
function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

const releaseTag = process.env.RELEASE_TAG ?? "";
if (!releaseTag) {
  fail("RELEASE_TAG is not set; it must be the git tag of the release");
}

const version = releaseTag.replace(/^v/, "");
const parsed = VERSION.exec(version);
if (!parsed) {
  fail(`release tag ${releaseTag} is not a semantic version`);
}

const packagePath = path.resolve("package.json");
const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
if (version !== packageVersion) {
  fail(
    `release tag ${releaseTag} does not match the version ${packageVersion} in ${packagePath}`,
  );
}

// Only the first identifier is the channel: `beta` out of `beta.1`.
const identifier = parsed.groups.prerelease?.split(".")[0];
const isPrerelease = process.env.PRERELEASE === "true";

if (identifier && !PRERELEASE_DIST_TAGS.includes(identifier)) {
  fail(
    `release tag ${releaseTag} has the prerelease identifier "${identifier}"; use one of ${PRERELEASE_DIST_TAGS.join(", ")}`,
  );
}
if (identifier && !isPrerelease) {
  fail(
    `${version} is a prerelease version, but the GitHub release is not marked as a pre-release`,
  );
}
if (!identifier && isPrerelease) {
  fail(
    `${version} is a stable version, but the GitHub release is marked as a pre-release; publishing it would move the latest tag`,
  );
}

const line = `dist_tag=${identifier ?? "latest"}`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}
console.log(line);
