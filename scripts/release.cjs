/*
 * Prepare and publish the installers in release/ for the version in package.json.
 *
 *   node scripts/release.cjs             # write SHA256SUMS.txt and GPG signatures
 *   node scripts/release.cjs --upload    # also attach everything to GitHub release v<version>
 *
 * Signs with GPG when `gpg` and a secret key are available: every installer and
 * SHA256SUMS.txt get a detached .asc signature, and the public key is exported
 * as switchboard-release-key.asc. Choose the key with GPG_KEY (fingerprint or
 * email); otherwise gpg's default key is used. Pass --no-sign to skip signing.
 * --upload needs the GitHub CLI (`gh`) signed in with access to the repository.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const pkg = require(path.join(projectRoot, "package.json"));
const releaseDir = path.join(projectRoot, "release");
const prefix = `${pkg.build.productName}-${pkg.version}-`;
const tag = `v${pkg.version}`;
const upload = process.argv.includes("--upload");
const sign = !process.argv.includes("--no-sign");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: releaseDir, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
}

const installers = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((name) => name.startsWith(prefix) && /\.(dmg|exe|AppImage|deb)$/.test(name)).sort()
  : [];
if (!installers.length) throw new Error(`No ${prefix}* installers in release/. Run npm run dist:mac, dist:win or dist:linux first.`);
console.log(`Installers for ${tag}:\n  ${installers.join("\n  ")}`);

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

const sums = installers.map((name) => `${sha256(path.join(releaseDir, name))}  ${name}\n`).join("");
fs.writeFileSync(path.join(releaseDir, "SHA256SUMS.txt"), sums);
const assets = [...installers, "SHA256SUMS.txt"];

if (sign) {
  if (spawnSync("gpg", ["--version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("gpg is not installed. Install GnuPG, or pass --no-sign.");
  }
  const keyArgs = process.env.GPG_KEY ? ["--local-user", process.env.GPG_KEY] : [];
  for (const name of [...installers, "SHA256SUMS.txt"]) {
    run("gpg", ["--batch", "--yes", "--armor", "--detach-sign", ...keyArgs, "--output", `${name}.asc`, name]);
    assets.push(`${name}.asc`);
  }
  // Export the key that actually made the signatures.
  const verified = spawnSync("gpg", ["--batch", "--status-fd", "1", "--verify", "SHA256SUMS.txt.asc", "SHA256SUMS.txt"],
    { cwd: releaseDir, encoding: "utf8" });
  const fingerprint = /\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/.exec(verified.stdout || "")?.[1];
  if (!fingerprint) throw new Error("Could not verify the new signature on SHA256SUMS.txt.");
  const publicKey = run("gpg", ["--armor", "--export", fingerprint], { stdio: ["ignore", "pipe", "inherit"] }).stdout;
  fs.writeFileSync(path.join(releaseDir, "switchboard-release-key.asc"), publicKey);
  assets.push("switchboard-release-key.asc");
  console.log(`Signed with ${fingerprint.replace(/(.{4})/g, "$1 ").trim()}`);
}

if (upload) {
  const exists = spawnSync("gh", ["release", "view", tag], { cwd: projectRoot, stdio: "ignore" }).status === 0;
  if (!exists) run("gh", ["release", "create", tag, "--title", `${pkg.build.productName} ${pkg.version}`, "--generate-notes"], { cwd: projectRoot });
  run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
  console.log(`Uploaded ${assets.length} files to ${tag}.`);
} else {
  console.log(`Ready in release/: ${assets.join(", ")}`);
}
