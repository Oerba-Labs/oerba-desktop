/* The Electron smoke run (npm run smoke). It is reached only from main.ts, only when config.ts found an unpackaged app
   given --selftest. It asserts from the main process, prints one line a check and exits with a status. */

import { app, BrowserWindow, type WebContentsView, type WebPreferences } from "electron";
import type { Config } from "./config";
import type { NavPolicy } from "./policy/navigation";
import type { Presence } from "./present/presence";
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
    await fetch(`${h.policy.oerbaOrigin}/__now`, { method: "POST", body: "second" });
    await until("the second read", async () => { await presence.refresh(); return notes.length > 0; });
    check("a new need, a failed deploy and a failed workspace made one notification each, and a good deploy none", notes.length === 3 && notes.map((n) => n.title).sort().join("|") === "A deploy failed|A workspace failed|Waiting on you", notes.map((n) => n.title).join("|"));
    check("the failed workspace's notification opens its card", notes.some((n) => n.route === "#/workspaces/card/alice/demo"));
    check("the badge follows", app.dock?.getBadge() === "2", String(app.dock?.getBadge()));
    await presence.refresh();
    check("reading the same answer again made none more", notes.length === 3);

    // 5. Links out. Opening the browser is replaced by a recorder, so nothing real opens.
    const opened: string[] = [];
    const realOpen = external.open;
    external.open = (url) => { opened.push(url); };
    try {
      await oerba.webContents.loadURL(`${h.policy.oerbaOrigin}/gate`);
      await sleep(1500);   // the frame inside the page tries window.open and window.top.location, three times each
      check("a frame inside Oerba's page opened nothing in the browser", opened.length === 0, opened.join(" "));
      check("and its attempts were recorded as refused", refusals.has("linkout:origin") || refusals.has("navigate:main"), refusals.list.slice(-6).join(" "));

      const before2 = opened.length;
      await sleep(2200);   // let any press of earlier be stale: a script's call with no press is refused for want of one
      await oerba.webContents.executeJavaScript("window.open('https://example.invalid/no-press')");
      await sleep(300);
      check("a call of Oerba's own page with no press opened nothing", opened.length === before2, opened.join(" "));

      h.getWin()?.showInactive();   // synthetic presses are not delivered to a window that was never shown
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
