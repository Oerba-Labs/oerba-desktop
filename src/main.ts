/* Oerba Desktop's main process: one window that opens on the bundled setup screen and, once Oerba answers, shows
   Oerba's live pages. It deploys nothing, holds no secret and changes nothing on the computer. */

import { app, autoUpdater as squirrel, BrowserWindow, dialog, ipcMain, net, powerMonitor, shell, WebContentsView, type WebPreferences } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SETUP_URL, SIMBAR_URL, UPDATE_URL } from "./policy/bundled";
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
import type { Idle } from "./update/decide";
import { UpdateWindow } from "./update/window";
import type { PresentFetch } from "./present/fetch";
import { RelayManager } from "./relay/manager";
import { loopbackUpstream, ONDEMAND } from "./relay/rules";
import { desktop, external, installHardening, setRole } from "./shell/hardening";
import { desktopToken, devPanelStateJs } from "./policy/desktoplink";
import { SimPanel } from "./sim/panel";
import { DeviceMemory } from "./sim/remember";
import { onDemandPorts } from "./present/ports";

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
// simOrigin is set by the dev panel alone, while it shows serve-sim's preview.
const policy: NavPolicy = { oerbaOrigin: config.oerbaOrigin, setupUrl: SETUP_URL, updateUrl: UPDATE_URL, simbarUrl: SIMBAR_URL, simOrigin: null };
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
let panel: SimPanel | null = null;

// What the probes touch: a file's existence, one fixed program with fixed words and no shell, and a GET.
const run: RunStatus = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: 5000, maxBuffer: 4_000_000, windowsHide: true }, (_err, stdout) => resolve(stdout ? String(stdout) : null));
});
const fetchFn: FetchLike = (url, init) => net.fetch(url, init);
const presentFetch: PresentFetch = (url, init) => net.fetch(url, init);
let quitting = false;
// Set when an update's restart begins. Electron's quitAndInstall closes every window first and quits only once all are closed,
// before any before-quit: were the main window's close still a hide here, the restart would stop at a hidden window, with the
// app running on the old version until it was quit by hand (0.4.3 and 0.5.0 were installed so). Cleared if the restart fails.
let restartingForUpdate = false;
let presence: Presence | null = null;
// electron-updater's own engine, whose feed is the one the build wrote. Only the self-test may put another in its place.
let testEngine: Engine | null = null;
// macOS's word on whether the person is away. Only the self-test may say it instead.
let testIdle: Idle | null = null;
const updater = new Updater(
  () => (testEngine ? Promise.resolve(testEngine) : realEngine()),
  () => ({ packaged: app.isPackaged || testEngine !== null, selftest: config.selftest && testEngine === null, inOerba: oerbaView !== null }),
  (s, before) => {
    presence?.setUpdate(s.phase === "none" ? null : { version: s.version, ready: s.phase === "ready" });
    updateWindow?.push();
    if (s.phase === "ready" && before.phase !== "ready") presence?.updateReady(s.version);
  },
  { now: () => Date.now(), idle: (seconds) => testIdle ?? powerMonitor.getSystemIdleState(seconds), panelOpen: () => panel?.server.alive === true, before: async () => { await panel?.close(); } },
);
/** A restart for an update asked for from the menu: the dev panel goes first, as from the update window. */
function restartForUpdate(): void { void (async () => { await panel?.close(); await updater.restart(); })(); }
let updateWindow: UpdateWindow | null = null;
// The localhost forwards. They dial On-Demand's names; only the self-test may put a loopback stand-in in their place, and
// only when config.ts found an unpackaged app given --selftest (a packaged app's config never holds one).
const relay = new RelayManager((config.relayUpstream !== null && loopbackUpstream(config.relayUpstream)) || ONDEMAND, () => presence?.redraw());

/** The setup screen or Oerba's page fills the window, less the dev panel's column at the right while it is open. */
function fit(view: WebContentsView): void {
  if (!win) return;
  const [width = 0, height = 0] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: width - (panel?.width(width) ?? 0), height });
}

function relayout(): void {
  if (setupView) fit(setupView);
  if (oerbaView) fit(oerbaView);
  panel?.layout();
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({ width: 1200, height: 800, minWidth: 640, minHeight: 480, show: !config.selftest, title: "Oerba", backgroundColor: "#F6F7F9", webPreferences: { ...SAFE } });
  w.on("resize", relayout);
  // Closing the window hides it: the app keeps running in the menu bar until Quit or ⌘Q.
  // It also closes the dev panel, which stops serve-sim: nothing of it stays armed in the simulator behind a hidden window.
  w.on("close", (e) => { if (!quitting && !restartingForUpdate) { e.preventDefault(); w.hide(); void panel?.close(); } });
  w.on("closed", () => { stopPolling(); win = null; setupView = null; oerbaView = null; void panel?.close(); });
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
  // The app names itself to Oerba's page, which then draws its Dev Panel button (src/policy/desktoplink.ts).
  wc.setUserAgent(`${wc.getUserAgent()} ${desktopToken(app.getVersion())}`);
  wc.on("did-finish-load", tellPage);
  win.contentView.addChildView(oerbaView);
  fit(oerbaView);
  // If Oerba cannot be reached after all (the tailnet dropped), the setup screen says what is missing.
  wc.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame) showSetup(); });
  void wc.loadURL(`${config.oerbaOrigin}/`);
  presence?.setIn();
}

/** Tells Oerba's page whether the dev panel is open, so that its Dev Panel button shows it, and the key its asks must carry: run
    only in the top frame of a page of Oerba's own, where a workspace's frame cannot read it, and holding nothing the page or a
    workspace said. */
function tellPage(): void {
  const wc = oerbaView?.webContents;
  // Not held back while the page loads: a frame still loading would hold it back past the main frame's load, when it is first
  // needed. The main frame can only be a page of Oerba's (src/policy/navigation.ts), and is asked again here.
  if (!wc || wc.isDestroyed() || !isOerbaPage(wc.mainFrame.url, policy)) return;
  void wc.mainFrame.executeJavaScript(devPanelStateJs(panel?.open ?? false, desktop.key)).catch(() => undefined);
}

function showWindow(): void {
  // A window closed by a restart for an update that then failed is made again, with the setup screen that leads to Oerba.
  if (!win) { win = createWindow(); showSetup(); }
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
  // A restart that has not ended the app within a minute (it waits at most ten seconds for serve-sim) did not happen: the window
  // goes back to hiding on close.
  squirrel.on("before-quit-for-update", () => { restartingForUpdate = true; setTimeout(() => { restartingForUpdate = false; }, 60_000).unref(); });
  squirrel.on("error", () => { restartingForUpdate = false; });
  serveBundled(__dirname);
  installHardening(policy);
  // Oerba's own page asked, by the app's own scheme, just after a press (the window handler held it to that).
  desktop.devPanel = (workspace) => { void presence?.devPanelFrom(workspace); };
  panel = new SimPanel(policy, SAFE, {
    window: () => win, relayout, choose: () => { void presence?.chooseDevice(); }, changed: () => { presence?.redraw(); tellPage(); },
    refuse: () => (app.isPackaged && !app.isInApplicationsFolder() ? "Move Oerba to Applications, open it from there, and press Open in iOS Simulator again." : null),
  });
  // Which device each workspace was last opened on: a file of the app's own, or, for the self-test, one in a scratch folder, so
  // that a run never touches the person's.
  const scratch = __SELFTEST__ && config.selftest ? mkdtempSync(path.join(tmpdir(), "oerba-selftest-")) : null;
  if (__SELFTEST__ && scratch) app.on("will-quit", () => { rmSync(scratch, { recursive: true, force: true }); });
  const memory = new DeviceMemory(path.join(scratch ?? app.getPath("userData"), "devices.json"));
  const devPanel = {
    show: (udid: string, name: string, ctx: { owner: string; name: string; remote: number } | null) => { showWindow(); return panel ? panel.show(udid, name, ctx) : Promise.resolve(); },
    close: () => panel?.close() ?? Promise.resolve(),
    loading: (status: string, device?: string | null) => { showWindow(); panel?.loading(status, device ?? null); },
    isOpen: () => panel?.open ?? false,
    say: (status: string) => panel?.say({ status }),
    context: () => panel?.context ?? null,
    device: () => (panel?.device ? { udid: panel.device, name: panel.status.device } : null),
    popup: (menu: Electron.Menu) => panel?.popup(menu),
  };
  presence = new Presence({ oerbaOrigin: config.oerbaOrigin, fetchFn: presentFetch, intervalMs: config.presentMs, windowShown: () => !!win && win.isVisible() && !win.isMinimized(), show: showWindow, openRoute, palette: openPalette, openUpdate: () => updateWindow?.show(), restartForUpdate, onIn: () => updater.start(), quit: () => app.quit(), relay, openLocal: (u) => external.open(u), panel: devPanel, memory, ports: config.selftest ? null : onDemandPorts(presentFetch) });
  presence.start();
  // The Mac's waking from sleep asks for an update too (a laptop asleep at the hour misses it).
  powerMonitor.on("resume", () => { void updater.check(); });
  // Before an update restarts the app, the dev panel stops serve-sim, which takes its loader out of the simulator.
  updateWindow = new UpdateWindow(policy, SAFE, updater, config.selftest, async () => { await panel?.close(); });
  win = createWindow();
  showSetup();
  if (__SELFTEST__ && config.selftest) {
    // Loaded only for an unpackaged app given --selftest (config.ts): the self-test is not in the packaged code path.
    void import("./selftest").then((m) => m.runSelftest({ config, policy, getWin: () => win, getSetup: () => setupView, getOerba: () => oerbaView, getPresence: () => presence, getUpdater: () => updater, getRelay: () => relay, openPalette, getUpdateWindow: () => updateWindow, setEngine: (e) => { testEngine = e; }, setIdle: (i) => { testIdle = i; }, SAFE, fit, getPanel: () => panel, dropScratch: () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); } }));
  }
  app.on("activate", () => { if (!win) { win = createWindow(); showSetup(); } else showWindow(); });
});

// Quitting waits for serve-sim to take its loader out of the simulator (at most its stop's ten seconds), then quits again: a loader
// left behind names a library inside this app, which apps launched later in that simulator would look for.
app.on("before-quit", (e) => {
  quitting = true;
  if (panel?.server.alive) { e.preventDefault(); void panel.close().finally(() => app.quit()); }
});
app.on("will-quit", () => { presence?.stop(); updater.stop(); void relay.stopAll(); });
app.on("window-all-closed", () => { /* the menu bar item keeps the app running */ });
