/*
 * Build the Linux AppImage and .deb into release/.
 *
 * On Linux it builds natively for the host architecture: it runs the app
 * build, rebuilds node-pty against Electron (npm ships no Linux prebuild), and
 * packages with only the Linux Claude Code binary.
 *
 * On macOS or Windows (or on Linux with --docker) it copies the working tree
 * into an x64 electronuserland/builder container, runs `npm ci` and this same
 * script there, and copies the AppImage and .deb back. Needs Docker; on macOS
 * with Colima or Docker Desktop, x64 runs under emulation.
 *
 *   node scripts/package-linux.cjs            # native on Linux, Docker elsewhere
 *   node scripts/package-linux.cjs --docker   # always use Docker
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { projectRoot, run, withOnlyClaudeBinary } = require("./claude-binary-package.cjs");

const BUILDER_IMAGE = "electronuserland/builder:22";
const useDocker = process.platform !== "linux" || process.argv.includes("--docker");

function buildNatively() {
  const builderCli = path.resolve(path.dirname(require.resolve("electron-builder/package.json")), "cli.js");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  run("npm", ["run", "build"]);
  withOnlyClaudeBinary(`claude-agent-sdk-linux-${arch}`, () => {
    run(process.execPath, [builderCli, "--linux", "AppImage", "deb", `--${arch}`, "--config.npmRebuild=true"]);
  });
}

function buildInDocker() {
  const docker = (args, options) => run("docker", args, options);
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    throw new Error("Docker is not running. Start Docker Desktop or Colima, or build on Linux.");
  }

  // The tracked and untracked-but-not-ignored files: what a fresh clone plus local edits would contain.
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: projectRoot, encoding: "utf8" });
  if (listed.status !== 0) throw new Error("git ls-files failed; run this from a git checkout.");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-linux-"));
  const outDir = path.join(staging, "out");
  const container = `switchboard-linux-build-${process.pid}`;
  try {
    for (const file of listed.stdout.split("\0").filter(Boolean)) {
      const source = path.join(projectRoot, file);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const target = path.join(staging, "project", file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    docker(["create", "--name", container, "--platform", "linux/amd64", "-w", "/project", BUILDER_IMAGE,
      "bash", "-lc", "npm ci && node scripts/package-linux.cjs && mkdir -p /out && cp release/*.AppImage release/*.deb /out/"]);
    // "/." copies the folder's contents, since the image already has a /project folder.
    docker(["cp", path.join(staging, "project") + "/.", `${container}:/project`]);
    console.log(`Building Linux packages in ${BUILDER_IMAGE}`);
    docker(["start", "--attach", container]);
    docker(["cp", `${container}:/out`, outDir]);
    fs.mkdirSync(path.join(projectRoot, "release"), { recursive: true });
    for (const name of fs.readdirSync(outDir)) {
      fs.copyFileSync(path.join(outDir, name), path.join(projectRoot, "release", name));
      console.log(`Ready: release/${name}`);
    }
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (useDocker) buildInDocker();
else buildNatively();
