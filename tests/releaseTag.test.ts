/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The script is run the way the workflow runs it, rather than imported: what
// matters is the contract with the runner — the environment in, the
// `dist_tag=` line in $GITHUB_OUTPUT, and the exit code.
const SCRIPT = path.join(__dirname, "..", "scripts", "release-tag.mjs");

interface Run {
  status: number | null;
  stdout: string;
  output: string;
}

/** Runs the script against a package.json holding `version`. */
function run(
  version: string,
  env: { RELEASE_TAG?: string; PRERELEASE?: string },
): Run {
  const cwd = mkdtempSync(path.join(tmpdir(), "release-tag-"));
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version }));
  const outputFile = path.join(cwd, "github-output");
  writeFileSync(outputFile, "");

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outputFile, ...env },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    output: readFileSync(outputFile, "utf8"),
  };
}

describe("release-tag", () => {
  describe("chooses the dist-tag", () => {
    it("publishes a stable version under latest", () => {
      const result = run("2.0.0", {
        RELEASE_TAG: "v2.0.0",
        PRERELEASE: "false",
      });

      expect(result.status).toBe(0);
      expect(result.output).toBe("dist_tag=latest\n");
    });

    it.each(["alpha", "beta", "rc"])(
      "publishes a %s version under its own tag",
      (identifier) => {
        const result = run(`2.0.0-${identifier}.1`, {
          RELEASE_TAG: `v2.0.0-${identifier}.1`,
          PRERELEASE: "true",
        });

        expect(result.status).toBe(0);
        expect(result.output).toBe(`dist_tag=${identifier}\n`);
      },
    );

    it("accepts a release tag with no leading v", () => {
      const result = run("2.0.0-beta.1", {
        RELEASE_TAG: "2.0.0-beta.1",
        PRERELEASE: "true",
      });

      expect(result.status).toBe(0);
      expect(result.output).toBe("dist_tag=beta\n");
    });

    it("reports the dist-tag on stdout, so a run by hand shows it", () => {
      const result = run("2.0.0", {
        RELEASE_TAG: "v2.0.0",
        PRERELEASE: "false",
      });

      expect(result.stdout).toContain("dist_tag=latest");
    });
  });

  describe("refuses the release", () => {
    it("when the release tag and package.json disagree", () => {
      const result = run("2.0.0", {
        RELEASE_TAG: "v1.9.0",
        PRERELEASE: "false",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain("v1.9.0");
      expect(result.stdout).toContain("2.0.0");
      expect(result.output).toBe("");
    });

    it("when a prerelease version is not marked as a pre-release", () => {
      const result = run("2.0.0-beta.1", {
        RELEASE_TAG: "v2.0.0-beta.1",
        PRERELEASE: "false",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("not marked as a pre-release");
      expect(result.output).toBe("");
    });

    it("when a stable version is marked as a pre-release", () => {
      const result = run("2.0.0", { RELEASE_TAG: "v2.0.0", PRERELEASE: "true" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("would move the latest tag");
      expect(result.output).toBe("");
    });

    it("when the prerelease identifier is not one of the three", () => {
      const result = run("2.0.0-preview.1", {
        RELEASE_TAG: "v2.0.0-preview.1",
        PRERELEASE: "true",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("preview");
      expect(result.stdout).toContain("alpha, beta, rc");
      expect(result.output).toBe("");
    });

    it("when the prerelease identifier is latest, which would take the pointer", () => {
      const result = run("2.0.0-latest.1", {
        RELEASE_TAG: "v2.0.0-latest.1",
        PRERELEASE: "true",
      });

      expect(result.status).toBe(1);
      expect(result.output).toBe("");
    });

    it("when the release tag is not a version", () => {
      const result = run("2.0.0", { RELEASE_TAG: "v2.0", PRERELEASE: "false" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("not a semantic version");
      expect(result.output).toBe("");
    });

    it("when there is no release tag at all", () => {
      const result = run("2.0.0", { PRERELEASE: "false" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("RELEASE_TAG");
      expect(result.output).toBe("");
    });
  });

  it("runs without GITHUB_OUTPUT, so the dist-tag can be checked before tagging", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "release-tag-"));
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ version: "2.0.0-beta.1" }),
    );
    const env = {
      ...process.env,
      RELEASE_TAG: "v2.0.0-beta.1",
      PRERELEASE: "true",
    };
    delete env.GITHUB_OUTPUT;

    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dist_tag=beta");
  });
});
