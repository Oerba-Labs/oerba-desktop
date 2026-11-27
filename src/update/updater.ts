/* Looking for an update every hour, downloading one as soon as it is found, and restarting into it when the person presses
   Restart, or by itself once it has waited a day and the person is away (decide.ts). A downloaded update is checked (zip.ts)
   and then handed to macOS's installer, and is ready only once the installer has taken it, so that any quit installs it and
   Restart restarts into it. The feed is the one the build's `publish` setting wrote into the app (app-update.yml); this file
   never names or sets one. */

import path from "node:path";
import { AWAY_IDLE_S, AWAY_POLL_MS, CHECK_EVERY_MS, canDownload, canRestart, mayCheck, mayDownloadAlone, mayRestartAlone, noUpdate, step, type Idle, type UpdateEvent, type UpdateState } from "./decide";
import { checkUpdateZip } from "./zip";
import { notesToText } from "./notes";

/** What the updater needs of electron-updater, so the self-test can stand in for it. */
export interface Engine {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  /** Checks the downloaded update and hands it to macOS's installer; resolves once the installer has taken it, and rejects if
      either refuses. Nothing is ready until it resolves. */
  stage(version: string): Promise<void>;
  on(event: "update-available", cb: (info: { version?: unknown; releaseNotes?: unknown }) => void): unknown;
  on(event: "download-progress", cb: (p: { percent?: unknown }) => void): unknown;
  on(event: "update-downloaded" | "error", cb: () => void): unknown;
}

/** electron-updater's settings, in one function so that the app and the test of a forged update (src/tamper.ts) cannot differ
    in them. No feed is set here.
    - autoDownload off: the Updater downloads, once step() has found the version plain, rather than electron-updater on its own.
    - autoInstallOnAppQuit off: electron-updater would hand a download to macOS's installer (Squirrel.Mac) before anything had
      read what it holds, and say it was downloaded before the installer had taken it. The app's own stage() hands it over,
      after its checks, and waits for the installer's answer.
    - no downgrade and no prerelease. */
export function appSettings<T extends { autoDownload: boolean; autoInstallOnAppQuit: boolean; autoRunAppAfterInstall: boolean; allowDowngrade: boolean; allowPrerelease: boolean; logger: unknown }>(u: T): T {
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.autoRunAppAfterInstall = true;
  u.allowDowngrade = false;
  u.allowPrerelease = false;
  u.logger = null;   // a failed check is no news: the next one asks again
  return u;
}

let real: Engine | null = null;

/** electron-updater's own, with the app's settings, and the hand-off to macOS's installer. One for the app's life. */
export async function realEngine(): Promise<Engine> {
  if (real) return real;
  const { autoUpdater } = await import("electron-updater");
  const { app, autoUpdater: squirrel } = await import("electron");
  appSettings(autoUpdater);
  // The file electron-updater downloaded, as its own event says, once its SHA-512 matched the feed's.
  let file: string | null = null;
  autoUpdater.on("update-downloaded", (e: { downloadedFile?: unknown }) => { file = typeof e?.downloadedFile === "string" ? e.downloadedFile : null; });
  const stage = async (version: string): Promise<void> => {
    if (file === null) throw new Error("nothing was downloaded");
    // This app's bundle (…/Oerba.app/Contents/MacOS/Oerba), whose own Info.plist names it.
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    const id = await bundleId(path.join(bundle, "Contents", "Info.plist"));
    const why = id === null ? "this app's own name could not be read" : await checkUpdateZip(file, { bundle: path.basename(bundle), id, version, current: app.getVersion() });
    if (why !== null) throw new Error(why);
    // electron-updater has already pointed the installer at its loopback copy of this file; asking it now is what its own
    // autoInstallOnAppQuit would have done. The installer checks the signature, unpacks it, and says update-downloaded.
    await new Promise<void>((resolve, reject) => {
      const ok = (): void => { squirrel.removeListener("error", bad); resolve(); };
      const bad = (e: Error): void => { squirrel.removeListener("update-downloaded", ok); reject(e); };
      squirrel.once("update-downloaded", ok);
      squirrel.once("error", bad);
      squirrel.checkForUpdates();
    });
  };
  real = {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    stage,
    on: ((event: string, cb: (...a: unknown[]) => void) => autoUpdater.on(event as "error", cb as () => void)) as Engine["on"],
  };
  return real;
}

/** The running app's bundle identifier, from its own Info.plist. */
async function bundleId(plist: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  try { await readFile(plist); } catch { return null; }
  return new Promise((resolve) => {
    execFile("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { timeout: 10_000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

/** What the Updater needs to restart by itself: the clock, the person's presence, whether the iPhone panel is open, and what
    must happen first (the panel closed, so serve-sim takes its loader out of the simulator). */
export interface Away {
  now(): number;
  idle(seconds: number): Idle;
  panelOpen(): boolean;
  before(): Promise<void>;
}

export class Updater {
  state: UpdateState = noUpdate();
  /** When the update now waiting became ready (the clock of Away), or null. */
  readyAt: number | null = null;
  /** The last version whose download or check failed, and when: it is not downloaded again by itself for a day. */
  failed: { version: string; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private awayTimer: NodeJS.Timeout | null = null;
  private wired = false;

  constructor(
    private readonly engine: () => Promise<Engine>,
    private readonly gate: () => { packaged: boolean; selftest: boolean; inOerba: boolean },
    private readonly changed: (s: UpdateState, before: UpdateState) => void,
    private readonly away: Away | null = null,
  ) {}

  private apply(e: UpdateEvent): void {
    const next = step(this.state, e);
    if (next === this.state) return;
    const before = this.state;
    this.state = next;
    if (next.phase === "ready" && before.phase !== "ready") this.readyAt = this.away?.now() ?? Date.now();
    if (next.phase !== "ready") this.readyAt = null;
    this.changed(next, before);
  }

  private async wire(): Promise<Engine> {
    const eng = await this.engine();
    if (!this.wired) {
      this.wired = true;
      eng.on("update-available", (info) => this.apply({ type: "found", version: info.version, notes: notesToText(info.releaseNotes) }));
      eng.on("download-progress", (p) => this.apply({ type: "progress", percent: typeof p.percent === "number" ? p.percent : 0 }));
      // Not update-downloaded: electron-updater's says only that its file arrived. Ready is when stage() says the installer has it.
      eng.on("error", () => this.apply({ type: "error" }));
    }
    return eng;
  }

  /** Called once the person is in: a check now and every hour, and a look every minute at whether it may restart by itself. */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, CHECK_EVERY_MS);
    this.timer.unref();
    if (this.away) {
      this.awayTimer = setInterval(() => { void this.restartIfAway(); }, AWAY_POLL_MS);
      this.awayTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.awayTimer) clearInterval(this.awayTimer);
    this.timer = null; this.awayTimer = null;
  }

  /** Asks the feed, and downloads at once what it offers (a version step() found plain), but for one that failed in the last day. */
  async check(): Promise<void> {
    // Not while a download is under way (a check's network error would mark it failed while it went on) or one is ready.
    if (!mayCheck(this.gate()) || this.state.phase === "downloading" || this.state.phase === "ready") return;
    try { await (await this.wire()).checkForUpdates(); } catch { /* the next check asks again */ }
    if (this.state.phase === "available" && mayDownloadAlone({ version: this.state.version, failed: this.failed, now: this.away?.now() ?? Date.now() })) await this.download();
  }

  /** Restarts into the waiting update if mayRestartAlone says it may, after Away's own step. True if it tried. A restart that
      works ends this process; one that does not (macOS's installer refused) waits another day, rather than closing the window
      again every minute the person is away. */
  async restartIfAway(): Promise<boolean> {
    const a = this.away;
    if (!a || !mayRestartAlone({ phase: this.state.phase, readyAt: this.readyAt, now: a.now(), idle: a.idle(AWAY_IDLE_S), panelOpen: a.panelOpen() })) return false;
    this.readyAt = a.now();
    await a.before();
    await this.restart();
    return true;
  }

  /** Downloads the update found, checks it and hands it to macOS's installer: started by check(), or by a press of Download. */
  async download(): Promise<void> {
    if (!canDownload(this.state)) return;
    const version = this.state.version;
    this.apply({ type: "download" });
    try {
      const eng = await this.wire();
      await eng.downloadUpdate();
      await eng.stage(version);
      this.apply({ type: "downloaded" });
    } catch {
      this.failed = { version, at: this.away?.now() ?? Date.now() };
      this.apply({ type: "error" });
    }
  }

  /** Restarts into the downloaded update: the person's press (the window or the menu), or restartIfAway. */
  async restart(): Promise<void> {
    if (!canRestart(this.state)) return;
    (await this.wire()).quitAndInstall();
  }
}
