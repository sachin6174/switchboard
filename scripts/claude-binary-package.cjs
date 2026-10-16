/*
 * The Agent SDK ships the Claude Code binary as one npm package per platform
 * (@anthropic-ai/claude-agent-sdk-<platform>-<arch>), and npm installs only the
 * host's. withOnlyClaudeBinary() puts exactly the target's package in
 * node_modules while an installer is packaged, so every installer carries only
 * its own binary even when it is built on another system. Packages it fetches
 * are checked against package-lock.json. node_modules is restored afterwards.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const scopeDir = path.join(projectRoot, "node_modules", "@anthropic-ai");
const parkingDir = path.join(projectRoot, "node_modules", ".switchboard-parked");
const PREFIX = "claude-agent-sdk-";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
}

function lockEntry(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));
  const entry = lock.packages[`node_modules/@anthropic-ai/${name}`];
  if (!entry || !entry.version || !entry.integrity) {
    throw new Error(`package-lock.json has no version and integrity for @anthropic-ai/${name}`);
  }
  return entry;
}

const installed = () => fs.readdirSync(scopeDir).filter((name) => name.startsWith(PREFIX));

function park(name) {
  const parked = path.join(parkingDir, name);
  fs.mkdirSync(parkingDir, { recursive: true });
  fs.rmSync(parked, { recursive: true, force: true });
  fs.renameSync(path.join(scopeDir, name), parked);
}

function fetchPackage(name) {
  const { version, integrity } = lockEntry(name);
  const spec = `@anthropic-ai/${name}@${version}`;
  console.log(`Fetching ${spec}`);
  fs.mkdirSync(parkingDir, { recursive: true });
  const packed = run("npm", ["pack", spec, "--pack-destination", parkingDir, "--silent"], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const tarball = path.join(parkingDir, packed.stdout.trim().split(/\r?\n/).pop());
  const [algorithm, expected] = integrity.split(/-(.*)/s);
  const actual = crypto.createHash(algorithm).update(fs.readFileSync(tarball)).digest("base64");
  if (actual !== expected) throw new Error(`${spec} does not match the integrity in package-lock.json`);
  const target = path.join(scopeDir, name);
  fs.mkdirSync(target);
  run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
  fs.rmSync(tarball);
}

/** Runs build() with @anthropic-ai/<name> as the only Claude Code platform package installed. */
function withOnlyClaudeBinary(name, build) {
  if (!name.startsWith(PREFIX)) throw new Error(`Not a Claude Code platform package: ${name}`);
  const initial = installed();
  try {
    if (!initial.includes(name)) {
      if (fs.existsSync(path.join(parkingDir, name))) fs.renameSync(path.join(parkingDir, name), path.join(scopeDir, name));
      else fetchPackage(name);
    }
    for (const other of installed()) if (other !== name) park(other);
    return build();
  } finally {
    for (const other of installed()) if (!initial.includes(other)) park(other);
    for (const name of initial) {
      if (!fs.existsSync(path.join(scopeDir, name))) fs.renameSync(path.join(parkingDir, name), path.join(scopeDir, name));
    }
    fs.rmSync(parkingDir, { recursive: true, force: true });
  }
}

module.exports = { projectRoot, run, withOnlyClaudeBinary };
