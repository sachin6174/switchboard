/* Build outside synced folders, then copy the finished installer into release/. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const builderCli = path.resolve(
  path.dirname(require.resolve("electron-builder/package.json")),
  "cli.js",
);
const temporaryOutput = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-build-"));
const releaseDir = path.join(projectRoot, "release");

function isDirectChildOf(child, parent) {
  const resolvedChild = fs.realpathSync(child);
  const resolvedParent = fs.realpathSync(parent);
  return path.dirname(resolvedChild).toLowerCase() === resolvedParent.toLowerCase();
}

function safelyRemoveTemporaryOutput() {
  // Recursive deletion is limited to the new directory created for this run.
  if (!path.basename(temporaryOutput).startsWith("switchboard-build-") ||
      !isDirectChildOf(temporaryOutput, os.tmpdir())) {
    throw new Error(`Refusing to remove an unexpected temporary path: ${temporaryOutput}`);
  }
  fs.rmSync(temporaryOutput, { recursive: true, force: true });
}

console.log(`Building Windows installer in ${temporaryOutput}`);
const result = spawnSync(process.execPath, [
  builderCli,
  "--win",
  "nsis",
  `--config.directories.output=${temporaryOutput}`,
], { cwd: projectRoot, stdio: "inherit", windowsHide: true });

if (result.error || result.status !== 0) {
  console.error(`Packaging failed. Temporary build files remain at ${temporaryOutput}`);
  if (result.error) throw result.error;
  process.exit(result.status || 1);
}

const installers = fs.readdirSync(temporaryOutput)
  .filter((name) => name.toLowerCase().endsWith(".exe") &&
    fs.statSync(path.join(temporaryOutput, name)).isFile());
if (installers.length !== 1) {
  throw new Error(`Expected one Windows installer in ${temporaryOutput}; found ${installers.length}.`);
}

fs.mkdirSync(releaseDir, { recursive: true });
const installerPath = path.join(releaseDir, installers[0]);
fs.copyFileSync(path.join(temporaryOutput, installers[0]), installerPath);
console.log(`Installer ready: ${installerPath}`);
try {
  safelyRemoveTemporaryOutput();
} catch (error) {
  console.warn(`Installer is ready, but temporary build files remain at ${temporaryOutput}: ${error.message}`);
}
