import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  OFFICIAL_DISTRIBUTION,
  OWN_DISTRIBUTION,
  applyDistribution,
  renderDistributionBlock,
  resolveConfig,
  rewriteDistributionSource,
  rewriteElectronBuilderPublish,
  run,
} from "./set-distribution.mjs";

const DISTRIBUTION_SAMPLE = [
  "export interface DistributionConfig {",
  "  githubOwner: string;",
  "}",
  "",
  "// DISTRIBUTION:BEGIN (rewritten by scripts/set-distribution.mjs at packaging time)",
  "export const DISTRIBUTION: DistributionConfig = {",
  '  githubOwner: "getpaseo",',
  '  githubRepo: "paseo",',
  '  npmCliPackage: "@getpaseo/cli",',
  '  npmServerPackage: "@getpaseo/server",',
  '  npmCliDistTag: "latest",',
  "};",
  "// DISTRIBUTION:END",
  "",
  "export function githubReleaseDownloadBaseUrl() {",
  "  return 1;",
  "}",
].join("\n");

const BUILDER_SAMPLE = [
  "appId: sh.paseo.desktop",
  "productName: Paseo",
  "publish:",
  "  provider: github",
  "  owner: getpaseo",
  "  repo: paseo",
  "mac:",
  "  notarize: true",
  "  hardenedRuntime: true",
  "  category: public.app-category.developer-tools",
].join("\n");

const COMPLETE_OWN = [
  "--own",
  "--npm-cli-package",
  "@pocharlies/cli",
  "--npm-server-package",
  "@pocharlies/server",
];

test("resolveConfig defaults to official", () => {
  assert.equal(resolveConfig([]).mode, "official");
  assert.deepEqual(resolveConfig([]).config, OFFICIAL_DISTRIBUTION);
  assert.equal(resolveConfig(["--official"]).config.githubOwner, "getpaseo");
});

test("own channel targets the real org owner, not the redirect path", () => {
  assert.equal(OWN_DISTRIBUTION.githubOwner, "pocharlies-org");
  const { config } = resolveConfig(COMPLETE_OWN);
  assert.equal(config.githubOwner, "pocharlies-org");
  assert.equal(config.githubRepo, "paseo");
});

test("--own is fail-closed: rejects incomplete and official npm packages", () => {
  // Missing npm packages entirely.
  assert.throws(() => resolveConfig(["--own"]), /requires an explicit own npm package/);
  // Only the CLI package, missing the server package.
  assert.throws(
    () => resolveConfig(["--own", "--npm-cli-package", "@pocharlies/cli"]),
    /npm-server-package/,
  );
  // An npm package that equals the official value is rejected (no silent official fallback).
  assert.throws(
    () =>
      resolveConfig([
        "--own",
        "--npm-cli-package",
        "@getpaseo/cli",
        "--npm-server-package",
        "@pocharlies/server",
      ]),
    /must differ from the official/,
  );
});

test("--own preserves the explicit own npm packages", () => {
  const { config } = resolveConfig(COMPLETE_OWN);
  assert.deepEqual(config, {
    githubOwner: "pocharlies-org",
    githubRepo: "paseo",
    npmCliPackage: "@pocharlies/cli",
    npmServerPackage: "@pocharlies/server",
    npmCliDistTag: "latest",
  });
});

test("mode selection is order-independent (no misleading flag order)", () => {
  const after = resolveConfig(COMPLETE_OWN).config;
  const before = resolveConfig([
    "--npm-cli-package",
    "@pocharlies/cli",
    "--npm-server-package",
    "@pocharlies/server",
    "--own",
  ]).config;
  assert.deepEqual(before, after);
});

test("--official and --own are mutually exclusive", () => {
  assert.throws(() => resolveConfig(["--own", "--official"]), /mutually exclusive/);
  assert.throws(() => resolveConfig(["--official", "--own"]), /mutually exclusive/);
});

test("renderDistributionBlock emits the configured literal", () => {
  const block = renderDistributionBlock({
    ...OWN_DISTRIBUTION,
    npmCliPackage: "@pocharlies/cli",
    npmServerPackage: "@pocharlies/server",
  });
  assert.match(block, /githubOwner: "pocharlies-org"/);
  assert.match(block, /npmCliPackage: "@pocharlies\/cli"/);
});

test("rewriteDistributionSource replaces only the marked block and is idempotent", () => {
  const own = {
    ...OWN_DISTRIBUTION,
    npmCliPackage: "@pocharlies/cli",
    npmServerPackage: "@pocharlies/server",
  };
  const once = rewriteDistributionSource(DISTRIBUTION_SAMPLE, own);
  assert.equal(rewriteDistributionSource(once, own), once);
  assert.match(once, /githubOwner: "pocharlies-org"/);
  assert.match(once, /export function githubReleaseDownloadBaseUrl/);
  assert.match(once, /DISTRIBUTION:BEGIN/);
  assert.match(once, /DISTRIBUTION:END/);
});

test("rewriteDistributionSource throws when markers are missing", () => {
  assert.throws(
    () => rewriteDistributionSource("no markers here", OFFICIAL_DISTRIBUTION),
    /markers/,
  );
});

test("rewriteElectronBuilderPublish changes only the publish block, leaving signing intact", () => {
  const next = rewriteElectronBuilderPublish(BUILDER_SAMPLE, { ...OWN_DISTRIBUTION });
  assert.match(next, /  owner: pocharlies-org/);
  assert.match(next, /  repo: paseo/);
  assert.match(next, /notarize: true/);
  assert.match(next, /hardenedRuntime: true/);
  assert.equal(rewriteElectronBuilderPublish(next, OWN_DISTRIBUTION), next);
});

test("rewriteElectronBuilderPublish throws when publish block is absent", () => {
  assert.throws(
    () => rewriteElectronBuilderPublish("productName: Paseo\n", OWN_DISTRIBUTION),
    /publish/,
  );
});

test("run rejects incomplete --own and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-set-dist-"));
  try {
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);

    assert.throws(
      () => run(["--own"], { distributionPath: distPath, builderPath }),
      /explicit own npm package/,
    );
    // No writes happened: both files are byte-identical to the inputs.
    assert.equal(readFileSync(distPath, "utf8"), DISTRIBUTION_SAMPLE);
    assert.equal(readFileSync(builderPath, "utf8"), BUILDER_SAMPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run writes a coherent own channel and --official restores the committed default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-set-dist-"));
  try {
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);

    run(COMPLETE_OWN, { distributionPath: distPath, builderPath });
    const dist = readFileSync(distPath, "utf8");
    assert.match(dist, /githubOwner: "pocharlies-org"/);
    assert.match(dist, /npmCliPackage: "@pocharlies\/cli"/);
    assert.match(dist, /npmServerPackage: "@pocharlies\/server"/);
    assert.match(readFileSync(builderPath, "utf8"), /owner: pocharlies-org/);

    run(["--official"], { distributionPath: distPath, builderPath });
    assert.equal(readFileSync(distPath, "utf8"), DISTRIBUTION_SAMPLE);
    assert.equal(readFileSync(builderPath, "utf8"), BUILDER_SAMPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDistribution round-trips official exactly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-set-dist-"));
  try {
    const distPath = path.join(dir, "distribution.ts");
    const builderPath = path.join(dir, "electron-builder.yml");
    writeFileSync(distPath, DISTRIBUTION_SAMPLE);
    writeFileSync(builderPath, BUILDER_SAMPLE);
    applyDistribution(OFFICIAL_DISTRIBUTION, { distributionPath: distPath, builderPath });
    assert.equal(readFileSync(distPath, "utf8"), DISTRIBUTION_SAMPLE);
    assert.equal(readFileSync(builderPath, "utf8"), BUILDER_SAMPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
