# Switchboard

Switchboard is a local desktop app for Windows, macOS and Linux with separate connections for ChatGPT, Claude account sign-ins, Claude API, and Google's Antigravity agent through the Gemini API. Its **CLI accounts** screen manages several accounts for the Claude Code, Codex and Antigravity (`agy`) command-line tools through [aiswitch](tools/aiswitch/README.md). Add, select, rename, update, or remove connections whenever you need. Conversations and the number of tokens used in Switchboard stay separate for each connection.

## Install and connect

1. Install the build for your system: `Switchboard Setup *.exe` on Windows, the `.dmg` on macOS, or the `.AppImage`/`.deb` on Linux (see **Build from source**). The builds are unsigned, so the system may show a publisher warning.
2. Choose **Add account** and select a connection type:
   - **ChatGPT:** Complete OpenAI's official **Sign in with ChatGPT** flow in your browser. The browser returns to Switchboard through a temporary local callback.
   - **Claude account:** Name the connection and complete the official Claude Code sign-in in your browser. Claude Code keeps each sign-in in a separate local profile; chat requests use Anthropic's Agent SDK and the selected Claude account. This route requires Anthropic's approval for a third-party product that offers claude.ai subscription login.
   - **Claude API:** Enter a [Claude Console API key](https://console.anthropic.com/settings/keys). A Claude Pro, Max, Team, or Enterprise subscription does not include API billing.
   - **Antigravity agent:** Enter a [Gemini API key](https://aistudio.google.com/apikey). This connects to Google's remote Antigravity agent through the Gemini API. It does not sign into the personal Antigravity IDE.
3. Select a connection in the sidebar to switch conversations. The account menu supports renaming, replacing an API key, reconnecting a browser sign-in, and removing an account. ChatGPT and Claude accounts can also be signed out without removing their local history.
4. Choose a model and send a text message. **Manage usage** or **API usage** opens that provider's first-party usage page.

ChatGPT uses [OpenAI's documented open-source client sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and the [Responses API route for ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). This source is [MIT licensed](LICENSE). OpenAI documents the plan usage flow for **open-source, locally hosted apps**; publish the corresponding source when distributing an installer built from it. Paid or remotely hosted apps follow a different [OpenAI intake path](https://developers.openai.com/siwc/token-sharing-open-source/).

## CLI accounts (aiswitch)

The **CLI accounts** screen is a front end for `tools/aiswitch/aiswitch.py`, which does all account switching for the coding CLIs. It needs **Python 3** (3.9 or newer) on the computer; the screen says so when Python is missing.

- **Sign in another account** opens a terminal running `aiswitch add <tool> <name>`. The account you are signed in to now is saved first; then the CLI's own sign-in starts (Codex and Claude open the browser; for agy, sign in inside agy and press Ctrl+C when done). The new account appears when you come back to the app.
- **Switch** puts a saved account's login in place for the CLI (`~/.codex/auth.json`, the Claude Code credentials, agy's credential-store entry). Every terminal and editor using that CLI on this computer then uses the new account.
- **Switch accounts automatically at the limit** adds aliases to `~/.zshrc`/`~/.bashrc` so `codex`, `claude` and `agy` run through `aiswitch run`. When the CLI prints its usage-limit message, aiswitch:
  1. checks with the provider that the account is really out (Claude: live limits; Codex: what it logged in the last 10 minutes; agy: `/usage`). If Claude or Codex report quota left, it keeps the session going, so text that only mentions a limit doesn't switch. A second limit message in the same session switches anyway.
  2. rests that account until its limit window actually resets (5 hours when the reset time isn't known), and skips accounts whose last read showed an empty window,
  3. signs in the next ready account, resumes the session, and types `continue` once the screen is ready (turn off with `"auto_continue": false` for a tool in `~/.aiswitch/config.json`).

  Available on macOS and Linux; on Windows use Switch. **Recent switches** on each tool lists what happened.
- Each account shows its plan, the limit windows it has left with reset times (Claude: read live with the account's own token; Codex: the latest value in its session logs; agy: `agy -p /usage`, signing in to each saved account in turn for a few seconds, never while an interactive agy session is open), and tokens per model over the last 7 days from the CLIs' local logs. No provider reports a remaining token balance.
- Rotating accounts to get around a provider's usage limits can break that provider's terms and put the accounts at risk. You decide whether to turn auto-switch on.

Saved logins live in `~/.aiswitch/profiles` (folders 0700, files 0600). Never share or sync that folder. The same features are available in a terminal: run `aiswitch` for a menu or `aiswitch usage`.

## Folders and terminals

**Folders** keeps a list of project folders (stored in the app's data folder, so it's there next time). **Open all three** starts Claude Code, Codex and Antigravity (`agy`) in that folder; the Claude, Codex and Antigravity buttons start just one.

- Each CLI runs through aiswitch (`aiswitch run <tool>`) in **full-permission mode**: `--dangerously-skip-permissions` for Claude and agy, `--dangerously-bypass-approvals-and-sandbox` for Codex. They edit files and run commands in the folder without asking. With auto-switch on, a usage limit switches accounts and resumes inside the same terminal.
- **Open terminals: Inside the app / Separate windows** chooses where they open (remembered). Inside, the **Terminals** view shows them as tabs or side by side; on macOS and Linux they start in your login shell so your PATH applies.
- **Open outside** stops an in-app terminal and continues its conversation (`claude --continue`, `codex resume --last`, `agy --continue`) in a terminal window. **Bring inside** does the reverse; close the outside window afterwards.
- In-app terminals use node-pty. It ships prebuilt binaries for Windows and macOS; on Linux, `npm ci` compiles it, which needs Python 3, `make` and a C++ compiler.

## Account switching and limits (Chat)

- ChatGPT access tokens are refreshed before expiry. If a session can no longer be renewed, Switchboard marks it as needing sign-in and selects another connected ChatGPT account, when one exists. Completing a new sign-in still requires OpenAI's browser flow. See [OpenAI's session guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
- Claude Code manages Claude account credentials inside an isolated profile for each account. Switchboard checks account status on launch and periodically. If the selected account needs sign-in or a chat request reports an authentication failure, it selects another connected **Claude account** when one exists. Reconnecting requires the browser sign-in again. [Anthropic documents `CLAUDE_CONFIG_DIR` for separate accounts](https://code.claude.com/docs/en/env-vars).
- If a Claude or Gemini API key is rejected as invalid, Switchboard marks that connection for key replacement and selects another ready connection **of the same provider**, when available. The app does not silently send a conversation to a different provider.
- In Chat, on a provider's rate or billing limit, requests pause for that connection. Chat does not rotate accounts or keys to work around limits. Retry after reviewing the provider's usage page and limits. Gemini limits apply to a project, so multiple keys for one project do not create independent quota. See [Claude API limits](https://platform.claude.com/docs/en/api/rate-limits) and [Gemini API limits](https://ai.google.dev/gemini-api/docs/rate-limits).
- **Tokens used** totals provider-reported input and output tokens from completed requests in this app. For Claude account chats, this includes input cache read/write tokens reported by the Agent SDK. For the Antigravity agent, the total also includes thought and tool tokens when reported. These are local usage records, not a remaining balance.
- ChatGPT and Claude account sign-ins do not expose an exact remaining plan token balance to Switchboard. Claude's API may report an **approximate current rate-window** token count after a request, rounded by Anthropic; it is not a subscription allowance or monthly credit balance. Gemini API quota is available in AI Studio. Use the provider usage links for applicable limits. See [OpenAI usage guidance](https://developers.openai.com/siwc/ui-ux-guidelines) and [Claude rate-limit headers](https://platform.claude.com/docs/en/api/rate-limits).

The personal Claude subscription login is separate from the [Claude Console API](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console). Anthropic's [Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/quickstart) requires prior approval for third-party products offering claude.ai login and subscription rate limits. [Google's Antigravity FAQ](https://www.antigravity.google/docs/faq/) does not allow third-party software to access a personal Antigravity login. Switchboard does not import site cookies or passwords. Google's [Antigravity agent API](https://ai.google.dev/gemini-api/docs/antigravity-agent) is a distinct, remotely hosted developer service with API billing.

## Local data and privacy

ChatGPT OAuth credentials and API keys are encrypted with the system credential protection (Windows DPAPI, macOS Keychain, or the Linux secret service) in separate local vaults. Claude Code owns the Claude account credentials in separate local configuration directories; Switchboard stores only account labels and IDs for those profiles. If a saved credential file can no longer be decrypted (for example, after the roaming profile syncs it from another Windows machine), Switchboard backs the unreadable file up next to the original and starts with an empty account list, so the app still opens. Sign in again to reconnect those accounts. Credentials stay outside the renderer; the interface only receives account summaries. Chat histories and usage totals are saved as local files per connection. Removing a connection deletes its local history and local credential profile. The app does not upload account lists to its own server.

ChatGPT requests go directly to OpenAI with `store: false` and streaming enabled, as required for the sign-in flow. Claude account chats use Anthropic's Agent SDK with tools, MCP servers, plugins, and project settings disabled; Claude API key chats use Anthropic's Messages API. Antigravity agent requests go directly to Google's Interactions API and run in Google's **remote** environment; Switchboard does not mount or send local Windows files. Google stores interaction state to support follow-up messages with `previous_interaction_id`. Clearing local chat removes the saved interaction link in Switchboard, but it does not delete provider-side interactions. Review the provider's own data controls for that service.

Automated tests cover vault behavior, credential failure handling, provider requests, usage parsing, and interrupted responses. UI previews were visually checked at multiple sizes and with accessibility checks. A real Claude or ChatGPT account sign-in and live API-key chat have **not** been tested here; verify Anthropic approval terms, plan eligibility, billing, key permissions, and current agent availability with your own accounts.

## Build from source

Needs Node.js 22 or newer (Electron 44's installer requires it) and Python 3 for aiswitch. From this folder:

```sh
npm ci
npm test
npm run dev
```

`npm run dev` builds the renderer and main process, then opens Electron. To make an installer:

```sh
npm run dist         # Windows .exe (run on Windows)
npm run dist:mac     # macOS .dmg and .zip (run on macOS)
npm run dist:linux   # Linux .AppImage and .deb (run on Linux)
```

`package-lock.json` was created on Windows, and npm leaves out other platforms' native packages in that case (npm issue #4828). On macOS or Linux, if the build stops with "Cannot find native binding" for rolldown, run `npm install --no-save @rolldown/binding-<platform>-<arch>` with the rolldown version shown in `node_modules/rolldown/package.json` (for example `@rolldown/binding-darwin-arm64`), or recreate the lockfile on that machine.

The Windows packaging script builds in a unique temporary directory to avoid file rename errors in synced workspaces, then copies the `.exe` to `release/`. It removes its own temporary directory after a successful copy. A failed build leaves the temporary directory in place and prints its path for troubleshooting.
