/* Oerba Desktop's main process: one window that opens on the bundled setup screen and, once Oerba answers, shows
   Oerba's live pages. It deploys nothing, holds no secret and changes nothing on the computer. */

import { app, BrowserWindow, dialog, ipcMain, net, shell, WebContentsView, type WebPreferences } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configFrom, TAILSCALE_DOWNLOAD } from "./config";
import { unexpectedSwitches } from "./policy/argv";
import { isSetupSender, type NavPolicy } from "./policy/navigation";
import { probeAll, type FetchLike, type RunStatus } from "./setup/probes";
import { computeSetup, type SetupState } from "./setup/state";
import { installHardening, setRole } from "./shell/hardening";

// Before anything loads: a packaged app opened with a command-line switch (a debugger port, no sandbox, no web security)
// is being asked to run loosened, and does not start. An unpackaged run is the developer's own and is unaffected.
if (app.isPackaged) {
  const bad = unexpectedSwitches(process.argv.slice(1));
  if (bad.length > 0) {
    dialog.showErrorBox("Oerba cannot start", `It was opened with options that would loosen its protections, so it will not run:\n\n${bad.join("\n").slice(0, 300)}\n\nOpen Oerba from the Applications folder or the Dock instead.`);
    app.exit(2);
  }
}

const config = configFrom(process.argv, app.isPackaged);
const setupPath = path.join(__dirname, "setup", "setup.html");
const policy: NavPolicy = { oerbaOrigin: config.oerbaOrigin, setupUrl: pathToFileURL(setupPath).href };

/** The settings every view gets. A remote page's has no preload, no Node and no <webview>. */
const SAFE: WebPreferences = {
  contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, spellcheck: false,
};

let win: BrowserWindow | null = null;
let setupView: WebContentsView | null = null;
let oerbaView: WebContentsView | null = null;
let current: SetupState | null = null;
let timer: NodeJS.Timeout | null = null;
let polling = false;

// What the probes touch: a file's existence, one fixed program with fixed words and no shell, and a GET.
const run: RunStatus = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: 5000, maxBuffer: 4_000_000, windowsHide: true }, (_err, stdout) => resolve(stdout ? String(stdout) : null));
});
const fetchFn: FetchLike = (url, init) => net.fetch(url, init);

function fit(view: WebContentsView): void {
  if (!win) return;
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({ width: 1200, height: 800, minWidth: 640, minHeight: 480, show: !config.selftest, title: "Oerba", backgroundColor: "#F6F7F9", webPreferences: { ...SAFE } });
  w.on("resize", () => { if (setupView) fit(setupView); if (oerbaView) fit(oerbaView); });
  w.on("closed", () => { stopPolling(); win = null; setupView = null; oerbaView = null; });
  return w;
}

function showSetup(): void {
  if (!win) return;
  if (oerbaView) { win.contentView.removeChildView(oerbaView); oerbaView.webContents.close(); oerbaView = null; }
  if (!setupView) {
    // The only preload in the app, and only this view has it.
    setupView = new WebContentsView({ webPreferences: { ...SAFE, preload: path.join(__dirname, "preload-setup.js") } });
    setRole(setupView.webContents, "setup");
    win.contentView.addChildView(setupView);
    fit(setupView);
    void setupView.webContents.loadURL(policy.setupUrl);
  }
  startPolling();
}

function showOerba(): void {
  if (!win || oerbaView) return;
  stopPolling();
  if (setupView) { win.contentView.removeChildView(setupView); setupView.webContents.close(); setupView = null; }
  // No preload: Oerba's pages get no bridge of any kind.
  oerbaView = new WebContentsView({ webPreferences: { ...SAFE } });
  const wc = oerbaView.webContents;
  setRole(wc, "oerba");
  win.contentView.addChildView(oerbaView);
  fit(oerbaView);
  // If Oerba cannot be reached after all (the tailnet dropped), the setup screen says what is missing.
  wc.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame) showSetup(); });
  void wc.loadURL(`${config.oerbaOrigin}/`);
}

async function check(): Promise<void> {
  const probes = await probeAll({ exists: existsSync, run, fetchFn, oerbaOrigin: config.oerbaOrigin });
  current = computeSetup(probes);
  if (setupView && !setupView.webContents.isDestroyed()) setupView.webContents.send("setup:state", current);
  if (current.ready) showOerba();
}

function startPolling(): void {
  if (polling) return;
  polling = true;
  const tick = async (): Promise<void> => {
    if (!polling) return;
    try { await check(); } catch { /* the next tick asks again */ }
    if (polling) timer = setTimeout(() => { void tick(); }, config.pollMs);
  };
  void tick();
}

function stopPolling(): void {
  polling = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

// The setup page's three calls. Each is answered only to that page's own top frame, in the setup view.
function fromSetup(event: Electron.IpcMainInvokeEvent): boolean {
  return setupView !== null && event.sender === setupView.webContents &&
    isSetupSender(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame, policy);
}
ipcMain.handle("setup:get", (event) => (fromSetup(event) ? current : null));
ipcMain.handle("setup:act", async (event, action: unknown) => {
  if (!fromSetup(event)) return;
  if (action === "open-tailscale-download") await shell.openExternal(TAILSCALE_DOWNLOAD);
  else if (action === "recheck") await check();
});

app.whenReady().then(() => {
  installHardening(policy);
  win = createWindow();
  showSetup();
  if (config.selftest) {
    // Loaded only for an unpackaged app given --selftest (config.ts): the self-test is not in the packaged code path.
    void import("./selftest").then((m) => m.runSelftest({ config, policy, getWin: () => win, getSetup: () => setupView, getOerba: () => oerbaView, SAFE, fit }));
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) { win = createWindow(); showSetup(); } });
});

app.on("window-all-closed", () => { app.quit(); });
