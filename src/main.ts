/* Oerba Desktop's main process: one window that opens on the bundled setup screen and, once Oerba answers, shows
   Oerba's live pages. It deploys nothing, holds no secret and changes nothing on the computer. */

import { app, BrowserWindow, dialog, ipcMain, net, shell, WebContentsView, type WebPreferences } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { SETUP_URL, UPDATE_URL } from "./policy/bundled";
import { declareBundledScheme, serveBundled } from "./shell/protocol";
import { configFrom, TAILSCALE_DOWNLOAD } from "./config";
import { unexpectedSwitches } from "./policy/argv";
import { isSetupSender, type NavPolicy } from "./policy/navigation";
import { probeAll, type FetchLike, type RunStatus } from "./setup/probes";
import { checkingSetup, computeSetup, type SetupState } from "./setup/state";
import { isOerbaPage } from "./policy/navigation";
import { safeRoute } from "./present/routes";
import { OPEN_PALETTE_JS } from "./present/palette";
import { Presence } from "./present/presence";
import { realEngine, Updater, type Engine } from "./update/updater";
import { UpdateWindow } from "./update/window";
import type { PresentFetch } from "./present/fetch";
import { RelayManager } from "./relay/manager";
import { loopbackUpstream, ONDEMAND } from "./relay/rules";
import { external, installHardening, setRole } from "./shell/hardening";

// Before anything loads: a packaged app opened with a command-line switch (a debugger port, no sandbox, no web security)
// is being asked to run loosened, and does not start. An unpackaged run is the developer's own and is unaffected.
if (app.isPackaged) {
  const bad = unexpectedSwitches(process.argv.slice(1));
  if (bad.length > 0) {
    dialog.showErrorBox("Oerba cannot start", `It was opened with options that would loosen its protections, so it will not run:\n\n${bad.join("\n").slice(0, 300)}\n\nOpen Oerba from the Applications folder or the Dock instead.`);
    app.exit(2);
  }
}

// Every renderer is sandboxed, whatever its own settings say.
app.enableSandbox();

const config = configFrom(process.argv, app.isPackaged);

// One instance. A second launch only shows the first one's window, and its arguments are never read. (The self-test runs
// beside any other copy, so it does not take the lock.)
if (!config.selftest && !app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => { showWindow(); });
const policy: NavPolicy = { oerbaOrigin: config.oerbaOrigin, setupUrl: SETUP_URL, updateUrl: UPDATE_URL };
declareBundledScheme();

/** The settings every view gets. A remote page's has no preload, no Node and no <webview>. */
const SAFE: WebPreferences = {
  contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, spellcheck: false,
};

let win: BrowserWindow | null = null;
let setupView: WebContentsView | null = null;
let oerbaView: WebContentsView | null = null;
let current: SetupState | null = checkingSetup();
let timer: NodeJS.Timeout | null = null;
let polling = false;

// What the probes touch: a file's existence, one fixed program with fixed words and no shell, and a GET.
const run: RunStatus = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: 5000, maxBuffer: 4_000_000, windowsHide: true }, (_err, stdout) => resolve(stdout ? String(stdout) : null));
});
const fetchFn: FetchLike = (url, init) => net.fetch(url, init);
const presentFetch: PresentFetch = (url, init) => net.fetch(url, init);
let quitting = false;
let presence: Presence | null = null;
// electron-updater's own engine, whose feed is the one the build wrote. Only the self-test may put another in its place.
let testEngine: Engine | null = null;
const updater = new Updater(
  () => (testEngine ? Promise.resolve(testEngine) : realEngine()),
  () => ({ packaged: app.isPackaged || testEngine !== null, selftest: config.selftest && testEngine === null, inOerba: oerbaView !== null }),
  (s) => { presence?.setUpdate(s.phase === "none" ? null : s.version); updateWindow?.push(); },
);
let updateWindow: UpdateWindow | null = null;
// The localhost forwards. They dial On-Demand's names; only the self-test may put a loopback stand-in in their place, and
// only when config.ts found an unpackaged app given --selftest (a packaged app's config never holds one).
const relay = new RelayManager((config.relayUpstream !== null && loopbackUpstream(config.relayUpstream)) || ONDEMAND, () => presence?.redraw());

function fit(view: WebContentsView): void {
  if (!win) return;
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({ width: 1200, height: 800, minWidth: 640, minHeight: 480, show: !config.selftest, title: "Oerba", backgroundColor: "#F6F7F9", webPreferences: { ...SAFE } });
  w.on("resize", () => { if (setupView) fit(setupView); if (oerbaView) fit(oerbaView); });
  // Closing the window hides it: the app keeps running in the menu bar until Quit or ⌘Q.
  w.on("close", (e) => { if (!quitting) { e.preventDefault(); w.hide(); } });
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
    // What the window did is said on the process's own output, for whoever runs the packaged app from a terminal.
    const sv = setupView.webContents;
    sv.on("did-fail-load", (_e, code, desc) => { console.error(`oerba: the setup page failed to load (${code} ${desc})`); });
    sv.on("did-finish-load", () => {
      // The page's script draws the steps just after it loads; look for a moment before saying how many.
      const look = (left: number): void => {
        if (sv.isDestroyed()) return;
        void sv.executeJavaScript("document.querySelectorAll('#steps li').length").then((n) => {
          if (Number(n) > 0 || left === 0) console.log(`oerba: the setup screen drew ${String(n)} steps`);
          else setTimeout(() => look(left - 1), 100);
        }, () => { /* gone */ });
      };
      look(20);
    });
    void sv.loadURL(policy.setupUrl);
  }
  presence?.setOut();
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
  presence?.setIn();
}

function showWindow(): void {
  if (!win) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens the window at a route of Oerba's page, by changing only its hash where the page is already loaded, so the page and
    its kept frames are not reloaded. The route is one this app built (safeRoute), and no bridge is given to the page. */
function openRoute(route: string): void {
  showWindow();
  if (!oerbaView || !safeRoute(route)) return;
  const wc = oerbaView.webContents;
  if (!wc.isLoading() && isOerbaPage(wc.getURL(), policy)) void wc.executeJavaScript(`location.hash = ${JSON.stringify(route.slice(1))}`);
  else void wc.loadURL(`${config.oerbaOrigin}/${route}`);
}

/** Oerba's own page opens its palette on ⌘K (it toggles, so a second press closes it). The key is dispatched on Oerba's own
    document, in its top frame alone, by a fixed string (src/present/palette.ts), never by sendInputEvent. */
function openPalette(): void {
  showWindow();
  if (!oerbaView) return;
  const wc = oerbaView.webContents;
  const top = wc.mainFrame;
  if (wc.isLoading() || !isOerbaPage(top.url, policy)) return;
  wc.focus();
  void top.executeJavaScript(OPEN_PALETTE_JS);
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
  serveBundled(__dirname);
  installHardening(policy);
  presence = new Presence({ oerbaOrigin: config.oerbaOrigin, fetchFn: presentFetch, intervalMs: config.presentMs, windowShown: () => !!win && win.isVisible() && !win.isMinimized(), show: showWindow, openRoute, palette: openPalette, openUpdate: () => updateWindow?.show(), onIn: () => updater.start(), quit: () => app.quit(), relay, openLocal: (u) => external.open(u) });
  presence.start();
  updateWindow = new UpdateWindow(policy, SAFE, updater, config.selftest);
  win = createWindow();
  showSetup();
  if (__SELFTEST__ && config.selftest) {
    // Loaded only for an unpackaged app given --selftest (config.ts): the self-test is not in the packaged code path.
    void import("./selftest").then((m) => m.runSelftest({ config, policy, getWin: () => win, getSetup: () => setupView, getOerba: () => oerbaView, getPresence: () => presence, getUpdater: () => updater, getRelay: () => relay, openPalette, getUpdateWindow: () => updateWindow, setEngine: (e) => { testEngine = e; }, SAFE, fit }));
  }
  app.on("activate", () => { if (!win) { win = createWindow(); showSetup(); } else showWindow(); });
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { presence?.stop(); updater.stop(); void relay.stopAll(); });
app.on("window-all-closed", () => { /* the menu bar item keeps the app running */ });
