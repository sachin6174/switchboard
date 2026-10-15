import { existsSync } from "node:fs";
import path from "node:path";

/** Use Anthropic's bundled native binary for this platform, never a shell wrapper or user config. */
export function claudeCodeBinary(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") throw new Error("Claude account sign-in isn't available on this system.");
  const cpu = arch === "arm64" ? "arm64" : "x64";
  // Linux distributions built on musl (Alpine) get their own package.
  const names = platform === "linux"
    ? [`@anthropic-ai/claude-agent-sdk-linux-${cpu}`, `@anthropic-ai/claude-agent-sdk-linux-${cpu}-musl`]
    : [`@anthropic-ai/claude-agent-sdk-${platform}-${cpu}`];
  for (const name of names) {
    let packageFile: string;
    try {
      packageFile = require.resolve(name + "/package.json");
    } catch {
      continue;
    }
    const packagedPath = path.join(path.dirname(packageFile), platform === "win32" ? "claude.exe" : "claude");
    const executable = packagedPath.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    if (existsSync(executable)) return executable;
  }
  throw new Error("The bundled Claude Code executable is missing. Reinstall Switchboard.");
}

export function claudeProcessEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const overridden = new Set([
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CONFIG_DIR", "CLAUDE_AGENT_SDK_CLIENT_APP",
  ]);
  // Windows treats environment names case-insensitively; plain JS objects do not.
  for (const key of Object.keys(env)) {
    if (overridden.has(key.toUpperCase())) delete env[key];
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "switchboard/0.3.0";
  return env;
}
