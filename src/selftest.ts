/* The Electron smoke run (npm run smoke). It is reached only from main.ts, only when config.ts found an unpackaged app
   given --selftest. It asserts from the main process, prints one line a check and exits with a status. */

import http from "node:http";
import { app, autoUpdater as squirrel, BrowserWindow, webContents, type WebContentsView, type WebPreferences } from "electron";
import type { Config } from "./config";
import type { NavPolicy } from "./policy/navigation";
import type { Presence } from "./present/presence";
import type { RelayManager } from "./relay/manager";
import type { Engine, Updater } from "./update/updater";
import type { Idle } from "./update/decide";
import type { UpdateWindow } from "./update/window";
import { sink } from "./present/presence";
import type { Item } from "./present/notify";
import { external, refusals, setRole } from "./shell/hardening";
import { simulator, type Runner } from "./sim/run";
import type { SimPanel } from "./sim/panel";
import { panelWidth } from "./sim/serve";

export interface Hooks {
  config: Config;
  policy: NavPolicy;
  getWin(): BrowserWindow | null;
  getSetup(): WebContentsView | null;
  getOerba(): WebContentsView | null;
  getPresence(): Presence | null;
  getUpdater(): Updater;
  getRelay(): RelayManager;
  openPalette(): void;
  getUpdateWindow(): UpdateWindow | null;
  setEngine(e: Engine): void;
  setIdle(i: Idle | null): void;
  SAFE: WebPreferences;
  fit(view: WebContentsView): void;
  getPanel(): SimPanel | null;
  /** Removes the run's scratch folder (the device memory's): app.exit skips will-quit. */
  dropScratch(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, f: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await f(); if (v) return v as NonNullable<T>; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export async function runSelftest(h: Hooks): Promise<void> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  // Notifications are recorded and never shown, in this run alone.
  const notes: Item[] = [];
  const noteClicks = new Map<Item, () => void>();
  sink.show = (item, onClick) => { notes.push(item); noteClicks.set(item, onClick); };
  const watchdog = setTimeout(() => { console.log("FAIL smoke run timed out"); h.dropScratch(); app.exit(1); }, 60_000);
  try {
    const other = h.config.otherOrigin;
    if (!other) throw new Error("--other-origin is needed");

    // 1. The setup screen showed, with its five steps drawn by the bundled script, and the bridge only there.
    const setup = await until("the setup view", () => h.getSetup());
    const steps = await until("the steps drawn", () => setup.webContents.executeJavaScript("document.querySelectorAll('#steps li').length === 5"));
    check("setup screen showed its five steps", steps === true);
    check("setup page is the bundled file", setup.webContents.getURL() === h.policy.setupUrl, setup.webContents.getURL());
    const bridge = await setup.webContents.executeJavaScript("Object.keys(window.oerbaSetup || {}).sort().join(',')");
    check("setup page has exactly its three calls", bridge === "act,getState,onState", String(bridge));
    const leak = await setup.webContents.executeJavaScript("typeof require + typeof process + typeof ipcRenderer");
    check("setup page has no Node", leak === "undefinedundefinedundefined", String(leak));

    // 2. A page of another origin, in a view like Oerba's (no preload), gets no bridge and its device asks are refused.
    const stranger = new BrowserWindow({ show: false, webPreferences: { ...h.SAFE } });
    setRole(stranger.webContents, "other");
    await stranger.loadURL(`${other}/`);
    const seen = await stranger.webContents.executeJavaScript("JSON.stringify([typeof window.oerbaSetup, typeof require, typeof process])");
    check("a page of another origin got no bridge", seen === '["undefined","undefined","undefined"]', String(seen));
    const serial = await stranger.webContents.executeJavaScript("navigator.serial.requestPort().then(() => 'granted', (e) => 'refused ' + e.name)", true);
    check("a serial device request was refused", String(serial).startsWith("refused"), String(serial));
    const geo = await stranger.webContents.executeJavaScript("new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('refused ' + e.code)))", true);
    check("a geolocation request was refused", String(geo).startsWith("refused"), String(geo));
    check("the refusals were seen by the handlers", refusals.has("serial") && refusals.has("geolocation"), refusals.list.join(" "));
    const media = await stranger.webContents.executeJavaScript("navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'granted', (e) => 'refused ' + e.name)", true);
    check("a screen-recording request was refused", String(media).startsWith("refused"), String(media));
    stranger.destroy();

    // 3. Oerba answers, and the setup screen lets the person in by itself.
    const flip = await fetch(`${h.policy.oerbaOrigin}/__open`, { method: "POST" });
    check("the stand-in was told to answer", flip.status === 204);
    const oerba = await until("Oerba's view", () => h.getOerba());
    await until("Oerba's page loaded", () => !oerba.webContents.isLoading() && oerba.webContents.getURL().startsWith(h.policy.oerbaOrigin));
    check("Oerba's page loaded in place of the setup screen", oerba.webContents.getURL() === `${h.policy.oerbaOrigin}/` && h.getSetup() === null);
    const none = await oerba.webContents.executeJavaScript("typeof window.oerbaSetup + typeof require");
    check("Oerba's page has no bridge", none === "undefinedundefined", String(none));

    // 4. Oerba's page cannot be sent to another origin.
    const before = refusals.total;
    void oerba.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${other}/away`)}`);
    await until("the navigation refused", () => refusals.total > before);
    await sleep(300);
    check("a navigation out of Oerba's page was refused", oerba.webContents.getURL() === `${h.policy.oerbaOrigin}/` && refusals.has("navigate:main"), oerba.webContents.getURL());

    // 4b. The menu bar item, the badge and the notifications, read from the stand-in's /api/now.
    const presence = await until("the presence", () => h.getPresence());
    await until("the first read of /api/now", () => presence.now !== null);
    const labels = presence.labels();
    const wanted = ["Open Oerba", "Workspaces", "  demo", "Waiting on you (1)", "New chat", "Switch workspace…", "Open at login", "Quit Oerba"];
    check("the menu bar item has its items", wanted.every((l) => labels.includes(l)), labels.join(" | "));
    check("it lists the person's started workspace and not another's", !labels.includes("  other"));
    check("the dock badge counts what waits on the owner", app.dock?.getBadge() === "1", String(app.dock?.getBadge()));
    check("the first read made no notification", notes.length === 0, String(notes.length));
    // 4d. The localhost relay, against a stand-in on loopback (--relay-upstream): a forward of alice's running workspace
    // answers on this Mac, says what it was sent, and stops when the poll no longer shows its workspace running.
    const relay = h.getRelay();
    const fwd = await relay.start("alice", "demo", 8081);
    check("a forward started on a loopback number", fwd !== null && fwd.local > 0, JSON.stringify(fwd));
    if (fwd) {
      const seen = (await (await fetch(`http://127.0.0.1:${fwd.local}/status?access_token=x`, { headers: { cookie: "a=b; ondemand_session_token=zz", authorization: "Bearer z" } })).json()) as { host: string; url: string; headers: Record<string, string> };
      check("the stand-in was reached by the workspace port's own name, with a cookie the workspace never set, and the browser's and credential headers, left out", seen.host === "8081--main--demo--alice.ondemand.oerba.dev" && seen.url === "/status" && !("cookie" in seen.headers) && !("authorization" in seen.headers), JSON.stringify(seen));
      // fetch will not set Host; node's http will.
      const bad = await new Promise<number>((resolve) => { const r = http.request({ host: "127.0.0.1", port: fwd.local, path: "/", headers: { host: `evil.example:${fwd.local}` }, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.on("error", () => resolve(0)); r.end(); });
      check("a wrong Host was refused", bad === 421, String(bad));
      await relay.reconcile([{ owner: "alice", name: "demo", status: "stopped" }]);
      const after = await fetch(`http://127.0.0.1:${fwd.local}/`).then((r) => r.status, () => 0);
      check("the forward stopped when its workspace did", after === 0 && relay.list().length === 0, String(after));
    }

    // 4e. The press that starts a forward: a web port opens the browser at the number it took, Metro's says where it is, and a
    // failure says why; the Dock menu carries the same Workspaces. The browser is a recorder, so nothing real opens.
    {
      const opened2: string[] = [];
      const realOpen2 = external.open;
      external.open = (u) => { opened2.push(u); };
      try {
        const n0 = notes.length;
        await presence.startForward("alice", "demo", 8000);
        const web = h.getRelay().list().find((f) => f.remote === 8000);
        check("a web port's press opened the browser at the number it took, and said nothing", !!web && opened2.length === 1 && opened2[0] === `http://localhost:${web.local}/` && notes.length === n0, `${opened2.join(" ")} ${notes.length - n0}`);
        await presence.startForward("alice", "demo", 8000);
        check("a second press of a running forward opened nothing more", opened2.length === 1);
        await presence.startForward("alice", "demo", 8081);
        const metro = h.getRelay().list().find((f) => f.remote === 8081);
        check("Metro's port notified and opened no browser", !!metro && opened2.length === 1 && notes.length === n0 + 1 && notes[notes.length - 1]!.body.startsWith(`localhost:${metro.local}`) && notes[notes.length - 1]!.body.endsWith("→ demo's 8081"), notes.map((n) => n.body).join("|"));
        await presence.startForward("alice", "a.b", 8081);
        check("a forward that could not start said why and opened nothing", notes.length === n0 + 2 && notes[notes.length - 1]!.title === "Could not open the port" && opened2.length === 1, notes.map((n) => n.body).join("|"));
        const dock = presence.dockLabels();
        check("the Dock menu has Open Oerba, Workspaces with the forwards, and New chat, and no Quit", dock.includes("Open Oerba") && dock.includes("New chat") && dock.some((l) => l.includes("(stop)")) && !dock.includes("Quit Oerba"), dock.join(" | "));
        const labels2 = presence.labels();
        check("the menu offers the Simulator on Metro's ports and on no web port", labels2.includes("    Open 8081 in iOS Simulator") && labels2.includes("    Open 19000 in iOS Simulator") && !labels2.some((l) => /Open (3000|5173|8000|8080|19006) in iOS Simulator/.test(l)), labels2.join(" | "));
        check("the Dock menu offers it too", presence.dockLabels().includes("    Open 8081 in iOS Simulator"));
        await h.getRelay().stopAll();
        notes.length = 0;
      } finally {
        external.open = realOpen2;
      }
    }

    await fetch(`${h.policy.oerbaOrigin}/__now`, { method: "POST", body: "second" });
    await until("the second read", async () => { await presence.refresh(); return notes.length > 0; });
    check("a new need, a failed deploy and a failed workspace made one notification each, and a good deploy none", notes.length === 3 && notes.map((n) => n.title).sort().join("|") === "A deploy failed|A workspace failed|Waiting on you", notes.map((n) => n.title).join("|"));
    check("the failed workspace's notification opens its page", notes.some((n) => n.route === "#/ws/alice/demo"));
    check("the badge follows", app.dock?.getBadge() === "2", String(app.dock?.getBadge()));
    await presence.refresh();
    check("reading the same answer again made none more", notes.length === 3);

    // 4f. "Open in iOS Simulator": offered on Metro's ports and on no web port; a press starts the forward, runs the sequence at the
    // number the forward took and says what it did once; a second press while one runs is ignored. The runner is a recorder that
    // answers like an Xcode with one booted iPhone and no Expo Go, so nothing on this Mac is touched.
    {
      const calls: string[] = [];
      let gate: (() => void) | null = null;
      const realRun = simulator.run;
      const SIM = "5E5E5E5E-0000-4000-8000-5E5E5E5E5E5E";
      const fake: Runner = async (file, args) => {
        calls.push([file, ...args].join(" "));
        const a = args.join(" ");
        if (a === "simctl list devices --json") {
          if (gate === null) await new Promise<void>((r) => { gate = r; });
          return { code: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: SIM, isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", state: "Booted", name: "iPhone 17 Pro" }] } }) };
        }
        return { code: a.startsWith("simctl get_app_container") ? 1 : 0, stdout: "" };
      };
      simulator.run = fake;
      try {
        const first = presence.openInSimulator("alice", "demo", 8081);
        await until("the sequence reached the device list", () => calls.length >= 3);
        const second = presence.openInSimulator("alice", "demo", 8081);   // while the first waits: ignored
        await second;
        const f = h.getRelay().list().find((x) => x.remote === 8081);
        check("the press started the forward", !!f);
        check("a second press while one runs ran nothing", calls.filter((c) => c.endsWith("list devices --json")).length === 1, calls.join(" | "));
        (gate as (() => void) | null)?.();
        await first;
        check("a booted device was used and nothing booted, and Device Hub was not opened (the panel shows the phone)", !!f && !calls.some((c) => c.startsWith("/usr/bin/open ")) && calls.includes(`/usr/bin/xcrun simctl get_app_container ${SIM} host.exp.Exponent`) && !calls.some((c) => c.includes("simctl boot")), calls.join(" | "));
        check("Expo Go missing: the address was not opened", !!f && !calls.some((c) => c.includes("openurl")), calls.join(" | "));   // what is said is the unit tests': the limiter here has no room left
        const c0 = calls.length;
        await presence.openInSimulator("alice", "demo", 8000);
        check("a press for a web port ran nothing and started no forward", calls.length === c0 && !h.getRelay().list().some((x) => x.remote === 8000));
        await h.getRelay().stopAll();
        notes.length = 0;
      } finally {
        simulator.run = realRun;
      }
    }

    // 4g. The dev panel, with Expo Go there: the press opens the address and then the panel beside Oerba's page, never Device Hub;
    // its bar names the device and the app, and its picker moves the app to another device, which the next press uses.
    // serve-sim is a stand-in that starts nothing and says why, so the panel shows its bar and the reason, and no preview.
    {
      const panel = h.getPanel();
      const win = h.getWin();
      const oerba = h.getOerba();
      const calls: string[] = [];
      const realRun = simulator.run;
      const SIM = "5E5E5E5E-0000-4000-8000-5E5E5E5E5E5E";
      const SIM2 = "6F6F6F6F-0000-4000-8000-6F6F6F6F6F6F";
      simulator.run = async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args.join(" ") === "simctl list devices --json") return { code: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: SIM, isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", state: "Booted", name: "iPhone 17 Pro" }, { udid: SIM2, isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", state: "Shutdown", name: "iPhone 17" }] } }) };
        return { code: 0, stdout: "" };
      };
      const realServer = panel?.server;
      const started: string[] = [];
      if (panel) panel.server = { running: null, alive: false, start: async (udid) => { started.push(udid); return { why: "a stand-in starts nothing" }; }, stop: async () => undefined };
      try {
        if (!panel || !win || !oerba) throw new Error("no panel, window or Oerba view");
        const [W = 0] = win.getContentSize();
        const before = oerba.getBounds().width;
        await presence.openInSimulator("alice", "demo", 8081);
        check("with Expo Go there, the address was opened and Device Hub was not", calls.includes(`/usr/bin/xcrun simctl openurl ${SIM} exp://127.0.0.1:${h.getRelay().list().find((x) => x.remote === 8081)?.local ?? 0}`) && !calls.some((c) => c.startsWith("/usr/bin/open ")), calls.join(" | "));
        check("the panel opened for that device", panel.open && started.join() === SIM, started.join());
        check("Oerba's page gave the panel its width, and no more", oerba.getBounds().width === W - panelWidth(W) && before === W, `${before} -> ${oerba.getBounds().width} of ${W}`);
        const bar = await until("the panel's bar", () => webContents.getAllWebContents().find((w) => w.getURL() === h.policy.simbarUrl));
        const said = await until("the bar's words", async () => { const t = String(await bar.executeJavaScript("document.getElementById('status').textContent")); return t.includes("stand-in") ? t : null; });
        check("the bar says why the panel could not start, and offers no Pop out", said.includes("a stand-in starts nothing") && !said.includes("Pop out"), said);
        check("the bar names the device and the workspace's app", await bar.executeJavaScript("document.getElementById('name').textContent + '|' + document.getElementById('app').textContent") === "iPhone 17 Pro|demo · Metro 8081");
        const items = await presence.deviceMenu();
        const listed = (items ?? []).filter((m) => m.kind !== "separator").map((m) => `${m.label}${m.checked ? " (ticked)" : ""}`).join("|");
        check("the picker lists the running device, ticked, then the others by runtime", listed === "Running|iPhone 17 Pro  iOS 26.5 (ticked)|iOS 26.5|iPhone 17", listed);
        // The bar's button asks the main process for the picker; a stand-in answers here, since a real menu waits for a click.
        let asked = 0;
        const realChoose = presence.chooseDevice;
        presence.chooseDevice = async () => { asked++; };
        await bar.executeJavaScript("document.getElementById('device').click(); 1");
        await until("the picker asked for", () => asked > 0);
        presence.chooseDevice = realChoose;
        check("the bar's device button asks for the picker", asked === 1, String(asked));
        // The forward's port is not compared here: the presence's own cycle may stop and start the forward between a press and a
        // check (the stand-in Oerba says the workspace failed), and the check above ties the address to the forward already.
        const opened = (c: string, udid: string): boolean => new RegExp(`^/usr/bin/xcrun simctl openurl ${udid} exp://127\\.0\\.0\\.1:\\d+$`).test(c);
        const c1 = calls.length;
        await presence.pickDevice("99999999-0000-4000-8000-999999999999");
        check("a device the picker did not list is not opened", calls.length === c1, calls.slice(c1).join(" | "));
        await presence.pickDevice(SIM2);
        check("a device chosen in the picker is booted, the app opened there, and the panel moved to it", calls.includes(`/usr/bin/xcrun simctl boot ${SIM2}`) && calls.slice(c1).some((c) => opened(c, SIM2)) && started[started.length - 1] === SIM2 && panel.device === SIM2, `${String(panel.device)} ${started.join()} ${calls.slice(c1).join(" | ")}`);
        const c2 = calls.length;
        await presence.openInSimulator("alice", "demo", 8081);
        check("the next press for that workspace uses the device it was last opened on", calls.slice(c2).some((c) => opened(c, SIM2)), calls.slice(c2).join(" | "));
        check("the bar's buttons are the device and Close, and no Pop out", await bar.executeJavaScript("document.getElementById('popout') === null && [...document.querySelectorAll('button')].map((b) => b.id).join() === 'device,close'") === true);
        check("no preview was made, and none may be loaded", h.policy.simOrigin === null && !webContents.getAllWebContents().some((w) => w.getURL().startsWith("http://127.0.0.1:3200")));
        check("the bar has a bridge, and Oerba's page still has none", await bar.executeJavaScript("typeof window.oerbaSimbar === 'object'") === true && await oerba.webContents.executeJavaScript("typeof window.oerbaSimbar") === "undefined");
        await bar.executeJavaScript("document.getElementById('close').click(); 1");
        await until("the panel closed", () => !panel.open);
        check("Close gave Oerba's page its width back", oerba.getBounds().width === W, String(oerba.getBounds().width));
        await h.getRelay().stopAll();
        notes.length = 0;
      } finally {
        simulator.run = realRun;
        if (panel && realServer) panel.server = realServer;
      }
    }

    // 4h. The ports a workspace listens on, from a stand-in for On-Demand: the menu offers those alone, and Metro starting earns one
    // offer to open the app, never on the first read, on the device last used for it (4g left iPhone 17). The presence's own cycle
    // reads too (every 400 ms here), so offers are counted, whichever read earned them. Offers have a budget of their own, so the
    // offer's notification is shown although the others' is full; clicked once Metro has stopped, it runs nothing.
    {
      await fetch(`${h.policy.oerbaOrigin}/__now/running`, { method: "POST" });
      await presence.refresh();
      let listening: number[] = [3000];
      const asked = new Set<string>();
      const n0 = presence.offerCount;
      const notes0 = notes.length;
      presence.ports = async (owner, name) => { asked.add(`${owner}/${name}`); return owner === "alice" && name === "demo" ? listening : null; };
      await presence.refresh();
      check("only the person's running workspace was asked about", [...asked].join() === "alice/demo", [...asked].join());
      check("the first read earned no offer", presence.offerCount === n0, String(presence.offerCount - n0));
      listening = [3000, 8081];
      await presence.refresh();
      check("Metro starting earned one offer, for its workspace and port", presence.offerCount === n0 + 1 && JSON.stringify(presence.lastOffer) === JSON.stringify({ owner: "alice", name: "demo", port: 8081 }), `${presence.offerCount - n0} ${JSON.stringify(presence.lastOffer)}`);
      await presence.refresh();
      await new Promise((r) => setTimeout(r, 500));
      check("Metro still listening earned none more", presence.offerCount === n0 + 1, String(presence.offerCount - n0));
      const offerNote = notes.slice(notes0).find((n) => n.title === "demo's app is running");
      check("the offer was notified, naming the device last used for that workspace", offerNote?.body === "Open it on iPhone 17", notes.slice(notes0).map((n) => `${n.title}: ${n.body}`).join(" | "));
      const labels3 = presence.labels();
      check("the menu offers the ports the workspace listens on, and no other", labels3.includes("    Open on localhost:3000") && labels3.includes("    Open 8081 in iOS Simulator") && !labels3.includes("    Open on localhost:5173") && !labels3.includes("    Open 19000 in iOS Simulator"), labels3.join(" | "));
      listening = [3000];
      await presence.refresh();
      const realRun = simulator.run;
      const ran: string[] = [];
      simulator.run = async (file, args) => { ran.push([file, ...args].join(" ")); return { code: 0, stdout: "" }; };
      try {
        const click = offerNote ? noteClicks.get(offerNote) : undefined;
        if (click) click();
        await new Promise((r) => setTimeout(r, 300));
        check("the offer clicked after Metro stopped ran nothing", !!click && ran.length === 0, ran.join(" | "));
      } finally { simulator.run = realRun; }
      presence.ports = null;
    }

    // 4c. An update, offered by a stand-in for electron-updater: downloaded by itself, said once, then the menu, the window and Restart.
    const calls: string[] = [];
    const handlers: Record<string, (x?: unknown) => void> = {};
    const fake: Engine = {
      checkForUpdates: async () => { calls.push("check"); handlers["update-available"]?.({ version: "9.9.9", releaseNotes: "<h2>What\u2019s new</h2><ul><li>One &amp; two</li></ul><script>alert(1)</script><img src=x onerror=alert(2)>" }); },
      downloadUpdate: async () => { calls.push("download"); handlers["download-progress"]?.({ percent: 50 }); handlers["update-downloaded"]?.(); },
      quitAndInstall: () => { calls.push("install"); },
      stage: async () => { calls.push("stage"); },
      on: ((event: string, cb: (x?: unknown) => void) => { handlers[event] = cb; }) as Engine["on"],
    };
    h.setEngine(fake);
    const n0u = notes.length;
    await h.getUpdater().check();
    check("an update found was downloaded, checked and handed to the installer at once, and not installed", calls.join() === "check,download,stage" && h.getUpdater().state.phase === "ready", `${calls.join()} ${h.getUpdater().state.phase}`);
    await until("the restart item in the menu", () => presence.labels().includes("Restart to Update to 9.9.9"));
    const item = presence.menu.find((m) => m.label === "Restart to Update to 9.9.9");
    check("the menu offers 'Restart to Update to 9.9.9', which restarts", item?.action?.type === "restart", JSON.stringify(item?.action));
    const said = notes.slice(n0u);
    check("one notification said it is ready", said.length === 1 && said[0]!.title === "Oerba 9.9.9 is ready", said.map((n) => n.title).join("|"));
    h.getUpdateWindow()?.show();
    const uw = await until("the update window", () => h.getUpdateWindow()?.window);
    await until("the update page", () => !uw.webContents.isLoading() && uw.webContents.getURL() === h.policy.updateUrl);
    const shown = (await until("the update text", () => uw.webContents.executeJavaScript("document.getElementById('notes').textContent"))) as string;
    check("the notes show as plain text, with no markup run", shown.includes("• One & two") && !shown.includes("<") && !shown.includes("alert"), JSON.stringify(shown));
    const made = await uw.webContents.executeJavaScript("document.querySelectorAll('img').length + ',' + document.querySelectorAll('script').length");
    check("the update page holds no element made from the notes", made === "0,1", String(made));   // its own script tag alone
    await until("Restart now offered", () => uw.webContents.executeJavaScript("document.getElementById('primary').textContent === 'Restart now'"));
    await uw.webContents.executeJavaScript("document.getElementById('primary').click()", true);
    await until("the install", () => calls.includes("install"));
    check("Restart now installed, after its own press", calls.join() === "check,download,stage,install", calls.join());
    uw.close();

    // 4c'. Restarting by itself: only a day after the update was ready, only when macOS says the person is away, the clock and
    // the presence said by the test. (The panel's part of the rule is the unit tests'.)
    const upd = h.getUpdater();
    const installs = (): number => calls.filter((c) => c === "install").length;
    const i0 = installs();
    upd.readyAt = Date.now() - 25 * 3600_000;
    h.setIdle("active");
    check("a day after, with the person at the Mac, it did not restart", !(await upd.restartIfAway()) && installs() === i0);
    upd.readyAt = Date.now() - 3600_000;
    h.setIdle("idle");
    check("an hour after, with the person away, it did not restart", !(await upd.restartIfAway()) && installs() === i0);
    upd.readyAt = Date.now() - 25 * 3600_000;
    h.setIdle("locked");
    check("a day after, with the screen locked, it restarted", (await upd.restartIfAway()) && installs() === i0 + 1, calls.join());
    check("and, the restart not having ended this run, it does not try again until a day later", !(await upd.restartIfAway()) && installs() === i0 + 1, calls.join());
    h.setIdle(null);

    // 5. Links out. Opening the browser is replaced by a recorder, so nothing real opens.
    const opened: string[] = [];
    const realOpen = external.open;
    external.open = (url) => { opened.push(url); };
    try {
      // The frame inside the page may try to send the page away while it loads, which aborts that load's promise: the page is read, not the promise.
      await oerba.webContents.loadURL(`${h.policy.oerbaOrigin}/gate`).catch(() => undefined);
      await until("the gate page", () => oerba.webContents.getURL() === `${h.policy.oerbaOrigin}/gate`);
      await sleep(1500);   // the frame inside the page tries window.open and window.top.location, three times each
      check("a frame inside Oerba's page opened nothing in the browser", opened.length === 0, opened.join(" "));
      check("and its attempts were recorded as refused", refusals.has("linkout:origin") || refusals.has("navigate:main"), refusals.list.slice(-6).join(" "));

      const before2 = opened.length;
      await sleep(2200);   // let any press of earlier be stale: a script's call with no press is refused for want of one
      await oerba.webContents.executeJavaScript("window.open('https://example.invalid/no-press')");
      await sleep(300);
      check("a call of Oerba's own page with no press opened nothing", opened.length === before2, opened.join(" "));

      // The shortcut's way of opening the palette: the key reaches Oerba's own document, not the frame inside it, and is no press.
      h.openPalette();
      await sleep(400);
      const keys = await oerba.webContents.executeJavaScript("window.__k || 0");
      const inner = oerba.webContents.mainFrame.frames[0];
      const innerKeys = inner ? await inner.executeJavaScript("window.__k || 0") : -1;
      check("the shortcut's key reached Oerba's own page and not the frame inside it", keys === 1 && innerKeys === 0, `${String(keys)} ${String(innerKeys)}`);
      const afterKey = opened.length;
      await oerba.webContents.executeJavaScript("window.open('https://example.invalid/after-palette')");
      await sleep(300);
      check("the shortcut is not a press: a link-out right after it was refused", opened.length === afterKey && refusals.has("linkout:gesture"), opened.join(" "));

      h.getWin()?.show(); h.getWin()?.focus();   // synthetic presses are not delivered to a window that was never shown
      oerba.webContents.focus();
      await sleep(500);
      const click = async (id: string): Promise<void> => {
        const r = (await oerba.webContents.executeJavaScript(`(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`)) as [number, number];
        const [x, y] = r;
        oerba.webContents.sendInputEvent({ type: "mouseMove", x, y });
        oerba.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        oerba.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        await sleep(500);
      };
      await click("blank");
      check("a click on a new-window link in Oerba's own page opened the browser", opened.includes("https://example.invalid/click-blank"), opened.join(" ") + " | " + refusals.list.slice(-4).join(" "));
      await click("same");
      check("a click on a link out of Oerba's own page opened the browser, and the page stayed", opened.includes("https://example.invalid/click-same") && oerba.webContents.getURL() === `${h.policy.oerbaOrigin}/gate`, opened.join(" "));
      check("each press opened one link", opened.length === 2, String(opened.length));
    } finally {
      external.open = realOpen;
    }

    // 6. A download is cancelled.
    const dl = refusals.total;
    oerba.webContents.downloadURL(`${h.policy.oerbaOrigin}/file`);
    await until("the download refused", () => refusals.total > dl && refusals.has("download"));
    check("a download was cancelled", true);

    // 7. Last, since it closes every window: Electron's own quitAndInstall, which closes the windows before it quits and quits only
    // once all are closed. The main window must close, not hide, or a restart for an update stops there. Nothing is downloaded
    // in this run, so Electron then says there is nothing to install, and the app stays.
    const gone: string[] = [];
    squirrel.once("error", (e) => { gone.push(String(e.message)); });
    squirrel.quitAndInstall();
    await until("the restart's end", () => gone.length > 0 || h.getWin() === null, 5000).catch(() => undefined);
    await sleep(300);
    check("Electron's restart for an update closed the main window rather than hiding it", h.getWin() === null, h.getWin() === null ? "" : h.getWin()?.isVisible() ? "still visible" : "hidden, and the app still running");
    check("and, with no update downloaded, it said so and quit nothing", gone.some((m) => /no update available/i.test(m)), gone.join("|"));
  } catch (e) {
    console.log(`FAIL ${(e as Error).message}`);
    failed++;
  }
  clearTimeout(watchdog);
  console.log(failed === 0 ? "smoke: all passed" : `smoke: ${failed} failed`);
  h.dropScratch();
  app.exit(failed === 0 ? 0 : 1);
}
