/* The Electron smoke run (npm run smoke). It is reached only from main.ts, only when config.ts found an unpackaged app
   given --selftest. It asserts from the main process, prints one line a check and exits with a status. */

import { app, BrowserWindow, type WebContentsView, type WebPreferences } from "electron";
import type { Config } from "./config";
import type { NavPolicy } from "./policy/navigation";
import { refusals, setRole } from "./shell/hardening";

export interface Hooks {
  config: Config;
  policy: NavPolicy;
  getWin(): BrowserWindow | null;
  getSetup(): WebContentsView | null;
  getOerba(): WebContentsView | null;
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
    check("the refusals were seen by the handlers", refusals.some((r) => r.includes("serial")) && refusals.some((r) => r.includes("geolocation")), refusals.join(" "));
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
    const before = refusals.length;
    void oerba.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${other}/away`)}`);
    await until("the navigation refused", () => refusals.length > before);
    await sleep(300);
    check("a navigation out of Oerba's page was refused", oerba.webContents.getURL() === `${h.policy.oerbaOrigin}/` && refusals.includes("navigate:main"), oerba.webContents.getURL());
  } catch (e) {
    console.log(`FAIL ${(e as Error).message}`);
    failed++;
  }
  clearTimeout(watchdog);
  console.log(failed === 0 ? "smoke: all passed" : `smoke: ${failed} failed`);
  app.exit(failed === 0 ? 0 : 1);
}
