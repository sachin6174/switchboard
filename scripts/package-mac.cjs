/*
 * Build one signed DMG per Mac architecture. Each DMG carries only its own
 * Claude Code binary, so the platform package for the other architecture is
 * moved aside while that architecture builds and put back afterwards.
 *
 * Signing uses the "Developer ID Application" identity in the login keychain
 * (override with CSC_NAME). Notarization runs when APPLE_KEYCHAIN_PROFILE,
 * APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, or
 * APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID is set.
 *
 *   node scripts/package-mac.cjs            # arm64 and x64
 *   node scripts/package-mac.cjs arm64      # one architecture
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const builderCli = path.resolve(
  path.dirname(require.resolve("electron-builder/package.json")),
  "cli.js",
);
const scopeDir = path.join(projectRoot, "node_modules", "@anthropic-ai");
const parkingDir = path.join(projectRoot, "node_modules", ".switchboard-parked");
const allArchs = ["arm64", "x64"];
const archs = process.argv.slice(2).length ? process.argv.slice(2) : allArchs;

const sdkPackage = (arch) => `claude-agent-sdk-darwin-${arch}`;
const sdkVersion = require(path.join(scopeDir, "claude-agent-sdk", "package.json")).version;

for (const arch of archs) {
  if (!allArchs.includes(arch)) throw new Error(`Unknown architecture: ${arch}`);
}

const hasNotaryCredentials = Boolean(
  process.env.APPLE_KEYCHAIN_PROFILE ||
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
  (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
);
if (!hasNotaryCredentials) {
  console.warn("No notarization credentials found: the DMGs will be signed but not notarized.");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

/** npm installs only the host's optional package; fetch the other one from the registry. */
function ensureSdkPackage(arch) {
  const target = path.join(scopeDir, sdkPackage(arch));
  const parked = path.join(parkingDir, sdkPackage(arch));
  if (fs.existsSync(target)) return;
  if (fs.existsSync(parked)) {
    fs.renameSync(parked, target);
    return;
  }
  const spec = `@anthropic-ai/${sdkPackage(arch)}@${sdkVersion}`;
  console.log(`Fetching ${spec}`);
  fs.mkdirSync(parkingDir, { recursive: true });
  const packed = spawnSync("npm", ["pack", spec, "--pack-destination", parkingDir, "--silent"], {
    cwd: projectRoot, encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(`npm pack ${spec} failed: ${packed.stderr}`);
  const tarball = path.join(parkingDir, packed.stdout.trim().split("\n").pop());
  fs.mkdirSync(target);
  run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
  fs.rmSync(tarball);
}

function parkSdkPackage(arch) {
  const target = path.join(scopeDir, sdkPackage(arch));
  if (!fs.existsSync(target)) return;
  fs.mkdirSync(parkingDir, { recursive: true });
  fs.renameSync(target, path.join(parkingDir, sdkPackage(arch)));
}

const initiallyPresent = allArchs.filter((arch) => fs.existsSync(path.join(scopeDir, sdkPackage(arch))));

try {
  for (const arch of archs) {
    ensureSdkPackage(arch);
    for (const other of allArchs) if (other !== arch) parkSdkPackage(other);
    console.log(`Building macOS ${arch} DMG`);
    run(process.execPath, [
      builderCli,
      "--mac",
      "dmg",
      `--${arch}`,
      `--config.mac.notarize=${hasNotaryCredentials}`,
    ]);
  }
} finally {
  // Leave node_modules as npm installed it.
  for (const arch of allArchs) {
    if (initiallyPresent.includes(arch)) ensureSdkPackage(arch);
    else parkSdkPackage(arch);
  }
  fs.rmSync(parkingDir, { recursive: true, force: true });
}
