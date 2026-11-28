/* A live run of the dev panel on this Mac, without Oerba's page: scripts/sim-panel-live.mjs builds and starts it. It opens the
   panel for the booted iPhone with the app's own code (src/sim/panel.ts, its server and the app's hardening), then checks:
   the preview draws; a click in it reaches the phone; the preview cannot be sent elsewhere; serve-sim's cookie is in the panel's
   own session alone; and closing the panel stops serve-sim and takes its loader out of the simulator. Prints one line a check. */

import { app, BrowserWindow, session, webContents, type WebContents } from "electron";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { SETUP_URL, SIMBAR_URL, UPDATE_URL } from "../../src/policy/bundled";
import type { NavPolicy } from "../../src/policy/navigation";
import { declareBundledScheme, serveBundled } from "../../src/shell/protocol";
import { installHardening, refusals } from "../../src/shell/hardening";
import { SIM_PARTITION, SimPanel } from "../../src/sim/panel";

const udid = process.env["SIM_LIVE_UDID"] ?? "";
const out = process.env["SIM_LIVE_OUT"] ?? "";
const SAFE = { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false };
let failed = 0;
const say = (ok: boolean, what: string): void => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const loader = (): string => execFileSync("/usr/bin/xcrun", ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"], { encoding: "utf8" }).trim();

app.enableSandbox();
declareBundledScheme();
app.whenReady().then(async () => {
  serveBundled(__dirname);
  const policy: NavPolicy = { oerbaOrigin: "https://app.oerba.dev", setupUrl: SETUP_URL, updateUrl: UPDATE_URL, simbarUrl: SIMBAR_URL, simOrigin: null };
  installHardening(policy);
  const win = new BrowserWindow({ width: 1100, height: 900, show: false, title: "Dev panel live run", webPreferences: { ...SAFE } });
  // Above the person's other windows, on whichever desktop they are on, without taking their keyboard: a covered window's pages
  // are hidden to Chromium, and a hidden page sends no taps.
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.showInactive();
  const panel = new SimPanel(policy, SAFE, { window: () => win, relayout: () => undefined, choose: () => undefined, refuse: () => null });
  try {
    await checks(panel, policy);
  } catch (e) {
    say(false, `the run stopped: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    // Whatever happened above, the panel is closed, and with it serve-sim, which takes its loader out of the simulator.
    await panel.close();
    say(!panel.server.alive, "closing the panel stopped serve-sim");
    say(loader() === "", "and its loader is out of the simulator");
    say(policy.simOrigin === null, "and the preview's origin is forgotten");
    console.log(failed === 0 ? "sim-panel-live: all passed" : `sim-panel-live: ${failed} failed`);
    app.exit(failed === 0 ? 0 : 1);
  }
});

/** A picture of the panel's preview as drawn, asked again for up to five seconds (a view only just drawn can refuse the first), or
    null when the Mac's screen is locked or the window is on no visible display, which Electron cannot capture. */
async function shoot(preview: WebContents, name: string): Promise<Buffer | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const png = (await preview.capturePage()).toPNG();
      if (png.length > 0) { writeFileSync(path.join(out, name), png); return png; }
    } catch (e) { if (String(e).includes("display surface not available")) return null; }
    await wait(500);
  }
  return null;
}

/** The phone's own screen, from serve-sim (its screenshot API, with the token the panel holds): what a tap changed, whatever the Mac's
    screen is doing. */
async function phone(server: { port: number; token: string }, name: string): Promise<Buffer> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/screenshot?format=jpeg&maxWidth=400&quality=80`, { method: "POST", headers: { authorization: `Bearer ${server.token}` } });
  if (!res.ok) throw new Error(`serve-sim's screenshot answered ${res.status}`);
  const jpg = Buffer.from(await res.arrayBuffer());
  writeFileSync(path.join(out, name), jpg);
  return jpg;
}

async function checks(panel: SimPanel, policy: NavPolicy): Promise<void> {
  const t0 = Date.now();
  await panel.show(udid, "iPhone", { owner: "live", name: "check", remote: 8081 });
  say(panel.server.running !== null, `serve-sim started for the device in ${Date.now() - t0} ms, on ${panel.server.running?.origin ?? `nothing (the bar says: ${panel.status.status})`}`);
  const origin = panel.server.running?.origin ?? "none";
  let preview: WebContents | undefined;
  for (let i = 0; i < 100 && !preview; i++) { preview = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin)); if (!preview) await wait(100); }
  say(preview !== undefined, "the preview loaded serve-sim's page");
  if (!preview) return;
  const p = preview;
  say(!p.getURL().includes("token="), "the token is not left in the preview's address");
  await wait(4000);
  const labels = (await p.executeJavaScript(`[...document.querySelectorAll("button,[role=button]")].map((b) => b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim()).filter(Boolean).join(" | ")`)) as string;
  console.log(`note serve-sim's buttons: ${labels.slice(0, 600)}`);
  const armed = loader();
  console.log(`note what the simulator loads while the panel is open: ${armed === "" ? "nothing" : armed.split(":").map((x) => path.basename(x)).join(", ")}`);
  const running = panel.server.running!;
  const shot1 = await shoot(p, "panel-1.png");
  if (shot1 === null) console.log("note the Mac's screen is locked or the window is on no display: the panel's own picture is skipped");
  else say(shot1.length > 1000, "the preview drew, panel-1.png");
  const phone1 = await phone(running, "phone-1.jpg");
  // A click in the preview is a tap on the phone: the starter app's Explore tab, then its Home tab again. The places are fractions
  // of the preview where serve-sim draws the starter app's tab bar in a 440-point panel; another app or size moves them.
  const [w, h] = (await p.executeJavaScript("[innerWidth, innerHeight]")) as [number, number];
  const click = async (fx: number, fy: number): Promise<void> => {
    const x = Math.round(w * fx), y = Math.round(h * fy);
    p.sendInputEvent({ type: "mouseMove", x, y });
    p.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    await wait(80);
    p.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await wait(2500);
  };
  const under = (await p.executeJavaScript(`(() => { const e = document.elementFromPoint(${Math.round(w * 0.577)}, ${Math.round(h * 0.853)}); return [document.visibilityState, innerWidth, innerHeight, e ? e.tagName + "." + String(e.className).slice(0, 40) : "nothing"].join(" "); })()`)) as string;
  console.log(`note the page is ${under}`);
  await click(0.577, 0.853);
  await shoot(p, "panel-2.png");
  const phone2 = await phone(running, "phone-2.jpg");
  // A page Chromium holds hidden (the Mac's screen locked, the window on no display) sends serve-sim no touches: that is no failure
  // of the panel's, and the check is said to be skipped rather than passed.
  if (under.startsWith("hidden")) console.log("note the page is hidden, so the tap is skipped: run this again with the screen unlocked");
  else say(!phone2.equals(phone1), "a click on Explore in the panel changed the phone's screen, phone-2.jpg");
  await click(0.424, 0.853);
  await shoot(p, "panel-3.png");
  await phone(running, "phone-3.jpg");
  const jar = await session.fromPartition(SIM_PARTITION).cookies.get({});
  const main = await session.defaultSession.cookies.get({});
  say(jar.some((c) => c.name.startsWith("serve_sim_access")), "serve-sim's cookie is in the panel's session");
  say(!main.some((c) => c.name.startsWith("serve_sim_access")), "and not in the default session");
  const media = (await p.executeJavaScript(`[...document.querySelectorAll("video,canvas,img")].map((e) => e.tagName + ":" + (e.videoWidth ?? e.width ?? 0) + "x" + (e.videoHeight ?? e.height ?? 0)).join(" ")`)) as string;
  console.log(`note the page's pictures: ${media || "none"}; refused before the test: ${refusals.list.filter((x) => x.startsWith("panel-request:")).join(" ") || "nothing"}`);
  // The preview's requests reach serve-sim alone: a request from its page to another port on this Mac is refused before it is sent.
  let hits = 0;
  const other = http.createServer((_q, r) => { hits++; r.end("x"); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const otherPort = (other.address() as { port: number }).port;
  const sent = (await p.executeJavaScript(`fetch("http://127.0.0.1:${otherPort}/", { mode: "no-cors" }).then(() => "through", () => "refused")`)) as string;
  other.close();
  say(sent === "refused" && hits === 0 && refusals.has("panel-request:"), `a request from the preview to another port was refused and never arrived (${sent}, ${hits})`);
  const before = refusals.total;
  await p.executeJavaScript("location.href = 'https://example.com/'; 1").catch(() => undefined);
  await wait(1000);
  say(p.getURL().startsWith(origin) && refusals.total > before, "the preview cannot be sent to another site");

  // serve-sim stopping by itself: the process listening on its port, once it is seen to be this run's own child, is sent SIGINT
  // (so that it still takes its loader out), and the panel must drop the preview and forget the origin it allowed.
  const pid = Number(execFileSync("/usr/sbin/lsof", ["-t", `-iTCP:${running.port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]);
  const parent = Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  if (!(pid > 0) || parent !== process.pid) { say(false, `the process on ${running.port} is not this run's own (${pid}, parent ${parent})`); return; }
  process.kill(pid, "SIGINT");
  for (let i = 0; i < 100 && (panel.server.alive || p.isDestroyed() === false); i++) await wait(100);
  say(!panel.server.alive && p.isDestroyed(), "when serve-sim stopped by itself, the panel dropped its preview");
  say(policy.simOrigin === null, "and forgot the origin it allowed");
}
