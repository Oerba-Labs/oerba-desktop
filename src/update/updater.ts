/* Looking for an update every hour, downloading one as soon as it is found, and restarting into it when the person presses
   Restart, or by itself once it has waited a day and the person is away (decide.ts). A downloaded update is handed to macOS's
   installer at once, so that any quit installs it. The feed is the one the build's `publish` setting wrote into the app
   (app-update.yml); this file never names or sets one. */

import { AWAY_IDLE_S, AWAY_POLL_MS, CHECK_EVERY_MS, canDownload, canRestart, mayCheck, mayRestartAlone, noUpdate, step, type Idle, type UpdateEvent, type UpdateState } from "./decide";
import { notesToText } from "./notes";

/** What the updater needs of electron-updater, so the self-test can stand in for it. */
export interface Engine {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "update-available", cb: (info: { version?: unknown; releaseNotes?: unknown }) => void): unknown;
  on(event: "download-progress", cb: (p: { percent?: unknown }) => void): unknown;
  on(event: "update-downloaded" | "error", cb: () => void): unknown;
}

/** electron-updater's settings, in one function so that the app and the test of a forged update (src/tamper.ts) cannot differ
    in them. No feed is set here.
    - autoDownload off: the Updater downloads, once step() has found the version plain, rather than electron-updater on its own.
    - autoInstallOnAppQuit on: a downloaded update is handed to macOS's installer (Squirrel.Mac) at once, which installs it when
      the app next quits for any reason; off, it was handed over only by Restart, so a quit by hand installed nothing.
    - no downgrade and no prerelease. */
export function appSettings<T extends { autoDownload: boolean; autoInstallOnAppQuit: boolean; autoRunAppAfterInstall: boolean; allowDowngrade: boolean; allowPrerelease: boolean; logger: unknown }>(u: T): T {
  u.autoDownload = false;
  u.autoInstallOnAppQuit = true;
  u.autoRunAppAfterInstall = true;
  u.allowDowngrade = false;
  u.allowPrerelease = false;
  u.logger = null;   // a failed check is no news: the next one asks again
  return u;
}

/** electron-updater's own, with the app's settings. */
export async function realEngine(): Promise<Engine> {
  const { autoUpdater } = await import("electron-updater");
  return appSettings(autoUpdater) as unknown as Engine;
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
      eng.on("update-downloaded", () => this.apply({ type: "downloaded" }));
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

  /** Asks the feed, and downloads at once what it offers (a version step() found plain). */
  async check(): Promise<void> {
    if (!mayCheck(this.gate())) return;
    try { await (await this.wire()).checkForUpdates(); } catch { /* the next check asks again */ }
    if (this.state.phase === "available") await this.download();
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

  /** Downloads the update found: started by check(), or by a press of Download after a failure. */
  async download(): Promise<void> {
    if (!canDownload(this.state)) return;
    this.apply({ type: "download" });
    try { await (await this.wire()).downloadUpdate(); } catch { this.apply({ type: "error" }); }
  }

  /** Restarts into the downloaded update: the person's press (the window or the menu), or restartIfAway. */
  async restart(): Promise<void> {
    if (!canRestart(this.state)) return;
    (await this.wire()).quitAndInstall();
  }
}
