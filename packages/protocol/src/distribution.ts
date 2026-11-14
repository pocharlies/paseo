// Single source of truth for where a packaged Paseo build gets its updates and its
// global CLI install from.
//
// The committed values are the OFFICIAL defaults, so an upstream build is unchanged.
// A downstream distributor flips them to its own channel at *packaging* time with
// `scripts/set-distribution.mjs`, which rewrites the DISTRIBUTION literal below and the
// electron-builder `publish` block. Those values are then compiled into the built
// artifact: nothing here reads `process.env` (or any other ambient input) at runtime, so
// a user's environment can never redirect where their app downloads updates from or
// which npm package the daemon installs. That is the whole point of baking it: the
// download source is fixed by whoever produced the binary, not by whoever runs it.
//
// Every consumer that resolves a download/install target must read from here so a build
// is internally consistent: the desktop auto-updater feed, the manual download link, the
// CLI inspection, `installLatest`, and the daemon install-origin version check all agree
// on the same configured package and repository.

export interface DistributionConfig {
  /** GitHub releases owner. The desktop feed and manual download link resolve here. */
  githubOwner: string;
  /** GitHub releases repo. The desktop feed and manual download link resolve here. */
  githubRepo: string;
  /** npm package the daemon self-update inspects and installs (`npm -g ls` / `install -g`). */
  npmCliPackage: string;
  /** npm package a running daemon identifies itself as (install-origin version check). */
  npmServerPackage: string;
  /** npm dist-tag `installLatest` installs. Official releases use `latest`. */
  npmCliDistTag: string;
}

export const OFFICIAL_DISTRIBUTION: DistributionConfig = {
  githubOwner: "getpaseo",
  githubRepo: "paseo",
  npmCliPackage: "@getpaseo/cli",
  npmServerPackage: "@getpaseo/server",
  npmCliDistTag: "latest",
};

// The distribution baked into this build. Defaults to official; a packaging run replaces
// the literal between the markers below (see scripts/set-distribution.mjs). Do not make
// this read from the environment: that would let a user redirect their update source.
// DISTRIBUTION:BEGIN (rewritten by scripts/set-distribution.mjs at packaging time)
export const DISTRIBUTION: DistributionConfig = {
  githubOwner: "getpaseo",
  githubRepo: "paseo",
  npmCliPackage: "@getpaseo/cli",
  npmServerPackage: "@getpaseo/server",
  npmCliDistTag: "latest",
};
// DISTRIBUTION:END

export function githubReleaseDownloadBaseUrl(config: DistributionConfig = DISTRIBUTION): string {
  return `https://github.com/${config.githubOwner}/${config.githubRepo}/releases/download`;
}
