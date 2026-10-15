const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const axe = require("axe-core");

const BASE_URL = process.env.SWITCHBOARD_PREVIEW_URL || "http://127.0.0.1:5173";
const OUTPUT = path.join(__dirname, "..", "artifacts", "screenshots");
app.on("window-all-closed", () => {});
// Writing to a closed pipe (output piped into a command that exits early) must not crash the run.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
const fixtures = [
  { name: "cli-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "status" },
  { name: "cli-1200-light", width: 1200, height: 800, theme: "light", preview: "accounts", view: "status" },
  { name: "cli-1024-light", width: 1024, height: 700, theme: "light", preview: "accounts", view: "status" },
  { name: "cli-1440-dark", width: 1440, height: 900, theme: "dark", preview: "accounts", view: "status" },
  { name: "cli-empty-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "status", cli: "empty" },
  { name: "cli-agy-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "status", action: "cli-agy" },
  { name: "cli-add-1440-dark", width: 1440, height: 900, theme: "dark", preview: "accounts", view: "status", action: "cli-add" },
  { name: "cli-nopython-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "status", cli: "nopython" },
  { name: "cli-windows-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "status", cli: "windows" },
  { name: "folders-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "folders" },
  { name: "folders-1440-dark", width: 1440, height: 900, theme: "dark", preview: "accounts", view: "folders" },
  { name: "folders-1024-light", width: 1024, height: 700, theme: "light", preview: "accounts", view: "folders" },
  { name: "terminals-1440-dark", width: 1440, height: 900, theme: "dark", preview: "accounts", view: "folders", action: "open-terminals" },
  { name: "terminals-split-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "folders", action: "open-terminals-split" },
  { name: "folders-empty-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", view: "folders", folders: "empty" },
  { name: "accounts-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts" },
  { name: "accounts-1200-light", width: 1200, height: 800, theme: "light", preview: "accounts" },
  { name: "accounts-1024-light", width: 1024, height: 700, theme: "light", preview: "accounts" },
  { name: "accounts-1440-dark", width: 1440, height: 900, theme: "dark", preview: "accounts" },
  { name: "usage-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", action: "usage" },
  { name: "usage-1200-light", width: 1200, height: 800, theme: "light", preview: "accounts", action: "usage" },
  { name: "usage-1024-light", width: 1024, height: 700, theme: "light", preview: "accounts", action: "usage" },
  { name: "usage-1440-dark", width: 1440, height: 900, theme: "dark", preview: "accounts", action: "usage" },
  { name: "claude-1440-light", width: 1440, height: 900, theme: "light", preview: "claude" },
  { name: "claude-1024-light", width: 1024, height: 700, theme: "light", preview: "claude" },
  { name: "claude-account-1440-light", width: 1440, height: 900, theme: "light", preview: "claude-account" },
  { name: "claude-account-1024-light", width: 1024, height: 700, theme: "light", preview: "claude-account" },
  { name: "antigravity-1440-dark", width: 1440, height: 900, theme: "dark", preview: "antigravity" },
  { name: "add-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", action: "add" },
  { name: "add-claude-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", action: "add-claude" },
  { name: "rename-1440-light", width: 1440, height: 900, theme: "light", preview: "accounts", action: "rename" },
  { name: "empty-1440-light", width: 1440, height: 900, theme: "light", preview: "empty" },
  { name: "claude-error-1440-light", width: 1440, height: 900, theme: "light", preview: "claude-error", action: "claude-fail" },
];

async function capture(fixture) {
  console.log(`Capturing ${fixture.name}`);
  nativeTheme.themeSource = fixture.theme;
  const window = new BrowserWindow({
    width: fixture.width,
    height: fixture.height,
    useContentSize: true,
    show: true,
    x: -20000,
    y: -20000,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 2) console.error("PAGE:", message); });
    await window.loadURL(`${BASE_URL}/?preview=${fixture.preview}&view=${fixture.view ?? "chat"}${fixture.cli ? `&cli=${fixture.cli}` : ""}${fixture.folders ? `&folders=${fixture.folders}` : ""}`);
    const CLI_EXPECTED = { empty: "No accounts yet", nopython: "Python 3 is needed", windows: "Not available on this system" };
    const expected = fixture.view === "folders" ? (fixture.folders === "empty" ? "No folders yet" : "payments-api") : fixture.view === "status" ? (CLI_EXPECTED[fixture.cli] ?? "you@company.com") : fixture.preview === "empty" || fixture.preview === "claude-error" ? "all in one place" : "Primary account";
    let ready = false;
    for (let retry = 0; retry < 40; retry += 1) {
      ready = await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(expected)})`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Preview did not render ${fixture.name}: ${await window.webContents.executeJavaScript("document.body.innerText.slice(0, 400)")}`);
    if (fixture.action === "rename") {
      await window.webContents.executeJavaScript("document.querySelector('.topbar-account').click()");
      await window.webContents.executeJavaScript("[...document.querySelectorAll('.account-menu button')].find(button => button.textContent.includes('Rename account')).click()");
    }
    if (fixture.action === "cli-agy") {
      await window.webContents.executeJavaScript("[...document.querySelectorAll('.cli-rail-item')].find(button => button.textContent.includes('Antigravity')).click()");
    }
    if (fixture.action === "cli-add") {
      await window.webContents.executeJavaScript("document.querySelector('.cli-profile-add-button').click()");
    }
    if (fixture.action === "open-terminals" || fixture.action === "open-terminals-split") {
      await window.webContents.executeJavaScript("document.querySelector('.folder-open-all').click()");
      for (let retry = 0; retry < 40; retry += 1) {
        if (await window.webContents.executeJavaScript("document.querySelectorAll('.term-pane .xterm').length === 3")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (fixture.action === "open-terminals-split") await window.webContents.executeJavaScript("[...document.querySelectorAll('.term-layout button')].find(b => b.textContent.includes('Side by side')).click()");
      await window.webContents.executeJavaScript("document.querySelectorAll('.term-pane:not([hidden]) textarea')[0]?.focus()");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (fixture.action === "usage") {
      await window.webContents.executeJavaScript("document.querySelector('.usage-top-link').click()");
    }
    if (fixture.action === "add" || fixture.action === "add-claude") {
      await window.webContents.executeJavaScript("document.querySelector('.topbar-account').click()");
      await window.webContents.executeJavaScript("document.querySelector('.menu-add-account').click()");
    }
    if (fixture.action === "add-claude") {
      await window.webContents.executeJavaScript("[...document.querySelectorAll('.provider-choices button')].find(button => button.textContent.includes('Claude account')).click()");
    }
    if (fixture.action === "claude-fail") {
      await window.webContents.executeJavaScript("document.querySelector('.topbar-account').click()");
      await window.webContents.executeJavaScript("document.querySelector('.menu-add-account').click()");
      await window.webContents.executeJavaScript("[...document.querySelectorAll('.provider-choices button')].find(button => button.textContent.includes('Claude account')).click()");
      await window.webContents.executeJavaScript("(() => { const input = document.querySelector('#claude-account-name'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'Personal Claude'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await window.webContents.executeJavaScript("document.querySelector('[aria-labelledby=claude-add-title] button[type=submit]').click()");
      for (let retry = 0; retry < 40; retry += 1) {
        if (await window.webContents.executeJavaScript("document.body.innerText.includes('Claude sign-in was not completed')")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await Promise.race([
      window.webContents.capturePage(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Screenshot timed out: ${fixture.name}`)), 10000)),
    ]);
    const output = path.join(OUTPUT, `${fixture.name}.png`);
    await fs.writeFile(output, image.toPNG());
    console.log(output);
    if (fixture.width === 1440) {
      await window.webContents.executeJavaScript(axe.source);
      const violations = await window.webContents.executeJavaScript("axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then(result => result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })))");
      await fs.writeFile(path.join(OUTPUT, `${fixture.name}-axe.json`), JSON.stringify(violations, null, 2));
      console.log(`Axe ${fixture.name}: ${violations.length} violations`);
    }
  } finally {
    window.destroy();
  }
}

app.whenReady().then(async () => {
  await fs.mkdir(OUTPUT, { recursive: true });
  const selected = process.env.SWITCHBOARD_CAPTURE_ONLY;
  for (const fixture of fixtures.filter((item) => !selected || item.name === selected)) await capture(fixture);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
