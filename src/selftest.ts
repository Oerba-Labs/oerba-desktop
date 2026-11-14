/* The Electron smoke run (npm run smoke). It is reached only from main.ts, only when config.ts found an unpackaged app
   given --selftest. It asserts from the main process, prints one line a check and exits with a status. */

import http from "node:http";
import { app, BrowserWindow, type WebContentsView, type WebPreferences } from "electron";
import type { Config } from "./config";
import type { NavPolicy } from "./policy/navigation";
import type { Presence } from "./present/presence";
import type { RelayManager } from "./relay/manager";
import type { Engine, Updater } from "./update/updater";
import type { UpdateWindow } from "./update/window";
import { sink } from "./present/presence";
import type { Item } from "./present/notify";
import { external, refusals, setRole } from "./shell/hardening";

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
  SAFE: WebPreferences;
  fit(view: WebContentsView): void;
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
  sink.show = (item) => { notes.push(item); };
  const watchdog = setTimeout(() => { console.log("FAIL smoke run timed out"); app.exit(1); }, 60_000);
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
      check("the stand-in was reached by the workspace port's own name, with the app's own cookie sent and On-Demand's, the browser's and credential headers left out", seen.host === "8081--main--demo--alice.ondemand.oerba.dev" && seen.url === "/status" && seen.headers["cookie"] === "a=b" && !("authorization" in seen.headers), JSON.stringify(seen));
      // fetch will not set Host; node's http will.
      const bad = await new Promise<number>((resolve) => { const r = http.request({ host: "127.0.0.1", port: fwd.local, path: "/", headers: { host: `evil.example:${fwd.local}` }, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.on("error", () => resolve(0)); r.end(); });
      check("a wrong Host was refused", bad === 421, String(bad));
      await relay.reconcile([{ owner: "alice", name: "demo", status: "stopped" }]);
      const after = await fetch(`http://127.0.0.1:${fwd.local}/`).then((r) => r.status, () => 0);
      check("the forward stopped when its workspace did", after === 0 && relay.list().length === 0, String(after));
    }

    await fetch(`${h.policy.oerbaOrigin}/__now`, { method: "POST", body: "second" });
    await until("the second read", async () => { await presence.refresh(); return notes.length > 0; });
    check("a new need, a failed deploy and a failed workspace made one notification each, and a good deploy none", notes.length === 3 && notes.map((n) => n.title).sort().join("|") === "A deploy failed|A workspace failed|Waiting on you", notes.map((n) => n.title).join("|"));
    check("the failed workspace's notification opens its page", notes.some((n) => n.route === "#/ws/alice/demo"));
    check("the badge follows", app.dock?.getBadge() === "2", String(app.dock?.getBadge()));
    await presence.refresh();
    check("reading the same answer again made none more", notes.length === 3);

    // 4c. An update, offered by a stand-in for electron-updater: the menu item, the window, Download and Restart.
    const calls: string[] = [];
    const handlers: Record<string, (x?: unknown) => void> = {};
    const fake: Engine = {
      checkForUpdates: async () => { calls.push("check"); handlers["update-available"]?.({ version: "9.9.9", releaseNotes: "<h2>What\u2019s new</h2><ul><li>One &amp; two</li></ul><script>alert(1)</script><img src=x onerror=alert(2)>" }); },
      downloadUpdate: async () => { calls.push("download"); handlers["download-progress"]?.({ percent: 50 }); handlers["update-downloaded"]?.(); },
      quitAndInstall: () => { calls.push("install"); },
      on: ((event: string, cb: (x?: unknown) => void) => { handlers[event] = cb; }) as Engine["on"],
    };
    h.setEngine(fake);
    await h.getUpdater().check();
    await until("the update item in the menu", () => presence.labels().includes("Update to 9.9.9…"));
    check("an update found put 'Update to 9.9.9…' in the menu", true);
    check("nothing was downloaded or installed by finding it", calls.join() === "check", calls.join());
    h.getUpdateWindow()?.show();
    const uw = await until("the update window", () => h.getUpdateWindow()?.window);
    await until("the update page", () => !uw.webContents.isLoading() && uw.webContents.getURL() === h.policy.updateUrl);
    const shown = (await until("the update text", () => uw.webContents.executeJavaScript("document.getElementById('notes').textContent"))) as string;
    check("the notes show as plain text, with no markup run", shown.includes("• One & two") && !shown.includes("<") && !shown.includes("alert"), JSON.stringify(shown));
    const made = await uw.webContents.executeJavaScript("document.querySelectorAll('img').length + ',' + document.querySelectorAll('script').length");
    check("the update page holds no element made from the notes", made === "0,1", String(made));   // its own script tag alone
    await uw.webContents.executeJavaScript("document.getElementById('primary').click()", true);
    await until("the download", () => calls.includes("download"));
    check("Download downloaded and did not install", !calls.includes("install"), calls.join());
    await until("Restart now offered", () => uw.webContents.executeJavaScript("document.getElementById('primary').textContent === 'Restart now'"));
    await uw.webContents.executeJavaScript("document.getElementById('primary').click()", true);
    await until("the install", () => calls.includes("install"));
    check("Restart now installed, after its own press", calls.join() === "check,download,install", calls.join());
    uw.close();

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
  } catch (e) {
    console.log(`FAIL ${(e as Error).message}`);
    failed++;
  }
  clearTimeout(watchdog);
  console.log(failed === 0 ? "smoke: all passed" : `smoke: ${failed} failed`);
  app.exit(failed === 0 ? 0 : 1);
}
