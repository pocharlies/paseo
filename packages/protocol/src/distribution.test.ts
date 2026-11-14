import { afterEach, describe, expect, it } from "vitest";
import {
  DISTRIBUTION,
  OFFICIAL_DISTRIBUTION,
  githubReleaseDownloadBaseUrl,
} from "./distribution.js";

describe("distribution", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore the environment so a leaked variable from another suite can't matter.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("defaults to the official channel", () => {
    expect(DISTRIBUTION).toEqual(OFFICIAL_DISTRIBUTION);
    expect(OFFICIAL_DISTRIBUTION).toEqual({
      githubOwner: "getpaseo",
      githubRepo: "paseo",
      npmCliPackage: "@getpaseo/cli",
      npmServerPackage: "@getpaseo/server",
      npmCliDistTag: "latest",
    });
  });

  it("does not let the environment redirect the download source", () => {
    // The baked value is a literal, not an env lookup: setting plausible variables must
    // not change where a build downloads from.
    process.env.PASEO_DISTRIBUTION_GITHUB_OWNER = "evil";
    process.env.PASEO_DISTRIBUTION_GITHUB_REPO = "evil";
    process.env.PASEO_DISTRIBUTION_NPM_CLI_PACKAGE = "@evil/cli";

    expect(DISTRIBUTION.githubOwner).toBe("getpaseo");
    expect(DISTRIBUTION.githubRepo).toBe("paseo");
    expect(DISTRIBUTION.npmCliPackage).toBe("@getpaseo/cli");
    expect(githubReleaseDownloadBaseUrl()).toBe(
      "https://github.com/getpaseo/paseo/releases/download",
    );
  });

  it("builds the release download base url from the configured repo", () => {
    expect(
      githubReleaseDownloadBaseUrl({ ...OFFICIAL_DISTRIBUTION, githubOwner: "pocharlies" }),
    ).toBe("https://github.com/pocharlies/paseo/releases/download");
  });
});
