// Packaging-time tool: fix a build's distribution channel by rewriting the baked values
// in the source before it is built. It is run by whoever produces the binaries (CI), never
// by an end user, and it changes *committed source* deterministically so the resulting
// artifact carries the chosen channel and the runtime never consults an environment
// variable to decide where to download from.
//
// What it rewrites:
//   1. packages/protocol/src/distribution.ts  — the DISTRIBUTION literal (between markers).
//   2. packages/desktop/electron-builder.yml   — the `publish:` owner/repo (the GitHub
//      releases feed electron-builder bakes into the packaged app-update.yml, which
//      electron-updater reads at runtime). Only the publish block is touched, so signing
//      and notarization settings are left exactly as committed.
//
// Modes (mutually exclusive, order-independent; default is `--official`):
//   --official  the upstream channel, which is what is committed.
//   --own       the pocharlies-org/paseo GitHub releases channel AND an explicit own npm
//               package. FAIL-CLOSED: --own refuses to run unless --npm-cli-package and
//               --npm-server-package are both supplied and differ from the official
//               @getpaseo/* packages. There is no silent fallback to the official npm
//               package: an "own" build whose CLI self-update still installs
//               @getpaseo/cli@latest is not a coherent own channel, so we fail before
//               writing anything rather than ship a half-own build.
//
// BLOCKER (deliberately not solved here, not worked around with a partial hack):
//   Producing the own npm package that --own points at is not a one-line change. Every
//   package in this monorepo is @getpaseo/* and every cross-package dependency, the
//   desktop's deps, the server package name the install-origin check reads, and the app's
//   imports all name that scope. Publishing @pocharlies/cli + @pocharlies/server means
//   renaming and republishing the whole monorepo (full-monorepo packaging), out of scope
//   for this minimal change. The alternative — keeping the @getpaseo/* names and pulling
//   them from a private registry — is NOT wired into the install path either: the npm
//   install/inspect commands do not pass a --registry today, so there is no coherent
//   private-registry channel to select. Until one of those exists, --own can only be used
//   once a real own package name is available; it will not pretend otherwise.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DISTRIBUTION_FILE = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "distribution.ts",
);
export const ELECTRON_BUILDER_FILE = path.join(
  REPO_ROOT,
  "packages",
  "desktop",
  "electron-builder.yml",
);

const BEGIN_MARKER = "// DISTRIBUTION:BEGIN";
const END_MARKER = "// DISTRIBUTION:END";

export const OFFICIAL_DISTRIBUTION = {
  githubOwner: "getpaseo",
  githubRepo: "paseo",
  npmCliPackage: "@getpaseo/cli",
  npmServerPackage: "@getpaseo/server",
  npmCliDistTag: "latest",
};

// Own GitHub releases channel. The owner is the real repo owner (pocharlies-org), not the
// old pocharlies path: pocharlies/paseo is only a transfer redirect and must not be baked
// into the feed. The npm package fields are intentionally left unset: an own channel must
// name its own packages explicitly (fail-closed), never inherit the official ones. See the
// blocker note above.
export const OWN_DISTRIBUTION = {
  githubOwner: "pocharlies-org",
  githubRepo: "paseo",
  npmCliPackage: undefined,
  npmServerPackage: undefined,
  npmCliDistTag: "latest",
};

const KEYS = ["githubOwner", "githubRepo", "npmCliPackage", "npmServerPackage", "npmCliDistTag"];

const FLAG_TO_KEY = {
  "--github-owner": "githubOwner",
  "--github-repo": "githubRepo",
  "--npm-cli-package": "npmCliPackage",
  "--npm-server-package": "npmServerPackage",
  "--npm-cli-dist-tag": "npmCliDistTag",
};

export function resolveConfig(argv) {
  let mode = "official";
  let sawOfficial = false;
  let sawOwn = false;
  const overrides = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--official") {
      if (sawOwn) throw new Error("--official and --own are mutually exclusive");
      sawOfficial = true;
      mode = "official";
      continue;
    }
    if (arg === "--own") {
      if (sawOfficial) throw new Error("--official and --own are mutually exclusive");
      sawOwn = true;
      mode = "own";
      continue;
    }
    const key = FLAG_TO_KEY[arg];
    if (key) {
      overrides[key] = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  // Baseline from the mode, then explicit overrides applied last so flag order never
  // changes the result (no misleading "--own after --npm-* resets it" behaviour).
  const baseline = mode === "own" ? OWN_DISTRIBUTION : OFFICIAL_DISTRIBUTION;
  const config = { ...baseline, ...overrides };

  if (mode === "own") {
    assertOwnNpmChannel(config);
  }

  validateConfig(config);
  return { mode, config };
}

// Fail-closed: an own channel must point at its own npm packages. Missing or official
// values are rejected before any file is written.
function assertOwnNpmChannel(config) {
  const missing = ["npmCliPackage", "npmServerPackage"].filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `--own requires an explicit own npm package: pass ${missing
        .map((key) => `--${key === "npmCliPackage" ? "npm-cli-package" : "npm-server-package"}`)
        .join(" and ")} different from the official @getpaseo/* packages. ` +
        "Refusing to fall back to the official package (see the blocker note).",
    );
  }
  const sameAsOfficial = ["npmCliPackage", "npmServerPackage"].filter(
    (key) => config[key] === OFFICIAL_DISTRIBUTION[key],
  );
  if (sameAsOfficial.length > 0) {
    throw new Error(
      `--own npm package must differ from the official ${sameAsOfficial
        .map((key) => OFFICIAL_DISTRIBUTION[key])
        .join(" / ")}; got the official value.`,
    );
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function validateConfig(config) {
  for (const key of KEYS) {
    const value = config[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Distribution ${key} must be a non-empty string`);
    }
  }
}

// Render the canonical DISTRIBUTION object literal (no trailing newline) for the markers.
export function renderDistributionBlock(config) {
  const lines = ["export const DISTRIBUTION: DistributionConfig = {"];
  for (const key of KEYS) {
    lines.push(`  ${key}: ${JSON.stringify(config[key])},`);
  }
  lines.push("};");
  return lines.join("\n");
}

// Replace the lines strictly between the BEGIN/END markers with the rendered block.
export function rewriteDistributionSource(source, config) {
  const lines = source.split("\n");
  const begin = lines.findIndex((line) => line.startsWith(BEGIN_MARKER));
  const end = lines.findIndex((line) => line.startsWith(END_MARKER));
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("distribution.ts is missing the DISTRIBUTION BEGIN/END markers");
  }
  const block = renderDistributionBlock(config).split("\n");
  return [...lines.slice(0, begin + 1), ...block, ...lines.slice(end)].join("\n");
}

// Rewrite the `owner:`/`repo:` values inside the top-level `publish:` block only. Other
// keys (and the whole mac/signing section) are returned untouched.
export function rewriteElectronBuilderPublish(source, config) {
  const lines = source.split("\n");
  const out = [...lines];
  let inPublish = false;
  let sawPublish = false;

  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    const isTopLevel = line.length > 0 && !/^\s/.test(line);
    if (isTopLevel) {
      inPublish = line.startsWith("publish:");
      if (inPublish) sawPublish = true;
      continue;
    }
    if (!inPublish) continue;
    const owner = line.match(/^(\s+)owner:\s*\S+\s*$/);
    const repo = line.match(/^(\s+)repo:\s*\S+\s*$/);
    if (owner) out[i] = `${owner[1]}owner: ${config.githubOwner}`;
    else if (repo) out[i] = `${repo[1]}repo: ${config.githubRepo}`;
  }

  if (!sawPublish) {
    throw new Error("electron-builder.yml has no top-level publish: block");
  }
  return out.join("\n");
}

export function applyDistribution(
  config,
  { distributionPath = DISTRIBUTION_FILE, builderPath = ELECTRON_BUILDER_FILE } = {},
) {
  fs.writeFileSync(
    distributionPath,
    rewriteDistributionSource(fs.readFileSync(distributionPath, "utf8"), config),
  );
  fs.writeFileSync(
    builderPath,
    rewriteElectronBuilderPublish(fs.readFileSync(builderPath, "utf8"), config),
  );
}

// Full CLI flow: resolve (and validate, fail-closed) BEFORE touching any file.
export function run(argv, paths) {
  const { mode, config } = resolveConfig(argv);
  applyDistribution(config, paths);
  return { mode, config };
}

function usageAndExit(code) {
  process.stderr.write(
    "Usage: node scripts/set-distribution.mjs [--official | --own] " +
      "(--own also requires --npm-cli-package and --npm-server-package) " +
      "[--github-owner <o>] [--github-repo <r>] [--npm-cli-dist-tag <tag>]\n",
  );
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  const { mode, config } = run(process.argv.slice(2));
  process.stdout.write(
    `Distribution set to ${mode}: github ${config.githubOwner}/${config.githubRepo}, ` +
      `npm ${config.npmCliPackage}@${config.npmCliDistTag}\n`,
  );
}
