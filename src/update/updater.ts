/* Looking for an update, and downloading and installing one only when the person presses for it. The feed is the one the
   build's `publish` setting wrote into the app (app-update.yml); this file never names or sets one. */

import { CHECK_EVERY_MS, canDownload, canRestart, mayCheck, noUpdate, step, type UpdateEvent, type UpdateState } from "./decide";
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

/** electron-updater's own, set to ask: nothing downloads and nothing installs by itself. No feed is set here. */
export async function realEngine(): Promise<Engine> {
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;   // a failed check is no news: the next one asks again
  return autoUpdater as unknown as Engine;
}

export class Updater {
  state: UpdateState = noUpdate();
  private timer: NodeJS.Timeout | null = null;
  private wired = false;

  constructor(
    private readonly engine: () => Promise<Engine>,
    private readonly gate: () => { packaged: boolean; selftest: boolean; inOerba: boolean },
    private readonly changed: (s: UpdateState) => void,
  ) {}

  private apply(e: UpdateEvent): void {
    const next = step(this.state, e);
    if (next !== this.state) { this.state = next; this.changed(next); }
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

  /** Called once the person is in: a check now, and one every six hours. */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async check(): Promise<void> {
    if (!mayCheck(this.gate())) return;
    try { await (await this.wire()).checkForUpdates(); } catch { /* the next check asks again */ }
  }

  /** The person pressed Download. */
  async download(): Promise<void> {
    if (!canDownload(this.state)) return;
    this.apply({ type: "download" });
    try { await (await this.wire()).downloadUpdate(); } catch { this.apply({ type: "error" }); }
  }

  /** The person pressed Restart. The only call that installs. */
  async restart(): Promise<void> {
    if (!canRestart(this.state)) return;
    (await this.wire()).quitAndInstall();
  }
}
