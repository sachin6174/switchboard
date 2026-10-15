# Switchboard design system

Switchboard is a calm desktop tool (Windows, macOS, Linux) for ChatGPT connections, Claude Console API keys, and a remote Antigravity agent backed by Gemini API keys. The interface keeps the active provider and account visible, makes account actions explicit, and distinguishes OAuth expiry, local tokens used, short-term API headroom, and personal plan allowances.

## Stack

- Electron, React, and TypeScript for the desktop app on Windows, macOS and Linux. The interface uses semantic HTML and one icon family: Lucide.
- No component library is needed for this focused tool. The reusable CSS tokens in `src/renderer/styles.css` are the single source for surfaces, text, borders, spacing, focus, and status colors.
- Typography uses the system UI font: Segoe UI Variable/Segoe UI on Windows, San Francisco on macOS, Ubuntu/Cantarell/Noto Sans on Linux.

## Visual direction

The account list is a quiet navigation rail with provider badges. The conversation is the largest surface. A compact account detail rail gives the relevant session or API key context without interrupting the task. The add-account dialog presents the supported connection choices, then asks for only the fields each provider needs.

The palette uses neutral blue-gray surfaces and a restrained teal accent for connected states and primary actions. Danger and warning colors appear only when they have meaning.

## Interaction rules

- All focusable controls have a visible three-pixel focus ring.
- Buttons meet a 44px minimum height where practical; icon-only actions include accessible labels.
- Spacing follows a 4px grid. Motion is short and disabled when the system prefers reduced motion.
- Both light and dark system themes are supported. Text and interactive colors target WCAG AA contrast.
- The UI never presents access-token expiry or locally used tokens as a remaining ChatGPT allowance. The Manage usage action opens ChatGPT settings.
- Claude API headers provide approximate tokens remaining in a short rate window. The label always says “API headroom” and explains it is separate from Claude subscriptions. Claude Console API billing is separate from paid Claude plans.
- The Antigravity remote agent uses Gemini API credentials and billing. A personal Antigravity IDE login stays in Google's product and cannot be connected to this third-party app. The UI provides a link to open that first-party experience.
- The CLI accounts screen opens first. It is a front end for aiswitch (`tools/aiswitch/aiswitch.py`), the only switching mechanism: the main process calls `aiswitch json …` with Python 3, one call at a time, and the renderer only receives account summaries, never credentials.
- Each tool (Claude Code, Codex, agy) lists its saved accounts. A row shows the email, the aiswitch name, plan, an Active badge, and a Resting badge while auto-switch rests an account after a limit. Limit bars show percent **left**: the accent above 30%, the warning color at 30% or less, the danger color at 10% or less. Tokens per model appear as a table; tokens that can't be credited to a saved account are listed separately.
- Switch, Clear rest and Remove act immediately; Remove asks first. Sign in another account asks for a short name, then opens a native terminal (Windows cmd, macOS Terminal, the first terminal emulator found on Linux) where the CLI's own sign-in runs. The list refreshes when the window regains focus.
- The auto-switch toggle (role="switch") turns the shell aliases on or off. Where it isn't supported (Windows), the card explains why instead of showing a toggle.
- Reads: on open, agy quota older than 5 minutes is re-checked; every minute a cheap background read uses cached agy quota and skips token counting; Refresh checks every agy account now.
- Folders lists saved project folders as cards: name, path, when last opened, **Open all three** and one button per CLI. A folder that was moved shows "moved or deleted" and its buttons are disabled. A warning card states that terminals start in full-permission mode. A segmented control chooses whether terminals open inside the app or in separate windows.
- Terminals keeps every in-app terminal running while other views are shown. Tabs or side by side; each pane has its title, a running dot, **Open outside**, **Restart** once it has ended, and close. Sessions running outside are listed as **Bring inside** chips. Terminal colours meet AA contrast, including dim text.
