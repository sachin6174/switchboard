/*
 * Build one signed DMG per Mac architecture, each carrying only its own Claude
 * Code binary. Run on macOS after `npm run build` (npm run dist:mac does both).
 *
 * Signing uses the "Developer ID Application" identity in the login keychain
 * (choose another with CSC_NAME). When notarization credentials are set, the
 * app is notarized during the build and the DMG is notarized and stapled
 * afterwards. Credentials, in order of preference:
 *   APPLE_KEYCHAIN_PROFILE                       (xcrun notarytool store-credentials)
 *   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *
 *   node scripts/package-mac.cjs            # arm64 and x64
 *   node scripts/package-mac.cjs arm64      # one architecture
 */
const path = require("node:path");
const { projectRoot, run, withOnlyClaudeBinary } = require("./claude-binary-package.cjs");

if (process.platform !== "darwin") throw new Error("macOS DMGs can only be built and signed on macOS.");

const { productName } = require(path.join(projectRoot, "package.json")).build;
const { version } = require(path.join(projectRoot, "package.json"));
const builderCli = path.resolve(path.dirname(require.resolve("electron-builder/package.json")), "cli.js");
const allArchs = ["arm64", "x64"];
const archs = process.argv.slice(2).length ? process.argv.slice(2) : allArchs;
for (const arch of archs) {
  if (!allArchs.includes(arch)) throw new Error(`Unknown architecture: ${arch}`);
}

const env = process.env;
const notaryArgs =
  env.APPLE_KEYCHAIN_PROFILE ? ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE] :
  env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER ?
    ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER] :
  env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID ?
    ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID] :
  null;
if (!notaryArgs) console.warn("No notarization credentials found: the DMGs will be signed but not notarized.");

for (const arch of archs) {
  withOnlyClaudeBinary(`claude-agent-sdk-darwin-${arch}`, () => {
    console.log(`Building macOS ${arch} DMG`);
    run(process.execPath, [builderCli, "--mac", "dmg", `--${arch}`, `--config.mac.notarize=${Boolean(notaryArgs)}`]);
  });
  if (notaryArgs) {
    const dmg = path.join(projectRoot, "release", `${productName}-${version}-${arch}.dmg`);
    console.log(`Notarizing ${path.basename(dmg)}`);
    run("xcrun", ["notarytool", "submit", dmg, ...notaryArgs, "--wait"]);
    run("xcrun", ["stapler", "staple", dmg]);
  }
}
