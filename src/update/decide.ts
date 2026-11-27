/* When the app asks for an update, what it does with an answer, what a downloaded update must be, and when the app may restart
   into one by itself. Pure: the download and the hand-off to macOS's installer are updater.ts's. */

/** How often an update is looked for, once the person is in; the Mac's waking from sleep asks too. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;

/** How long a downloaded update waits for the person to restart before the app restarts itself, when they are away. */
export const READY_GRACE_MS = 24 * 60 * 60 * 1000;

/** Away: the Mac has had no input for this long (seconds), or its screen is locked. */
export const AWAY_IDLE_S = 7 * 60;

/** How often the app asks whether it may restart itself for an update. */
export const AWAY_POLL_MS = 60 * 1000;

/** How long a version whose download or check failed waits before the app tries it again by itself (a press of Download does
    not wait): a feed offering something that never passes is not fetched again every hour. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** What macOS says of the person's presence (Electron's powerMonitor.getSystemIdleState). */
export type Idle = "active" | "idle" | "locked" | "unknown";

/** Whether the app may restart itself to install a downloaded update: only when one is ready, a day has passed since it was,
    the person is away (no input for AWAY_IDLE_S, or the screen locked; "unknown" is not away), and the iPhone panel is closed,
    so that no simulator session is cut short. */
export function mayRestartAlone(s: { phase: Phase; readyAt: number | null; now: number; idle: Idle; panelOpen: boolean }): boolean {
  return s.phase === "ready" && s.readyAt !== null && s.now - s.readyAt >= READY_GRACE_MS && (s.idle === "idle" || s.idle === "locked") && !s.panelOpen;
}

/** Updates are looked for only by a packaged app, never by a self-test, and only once the person is in. */
export function mayCheck(s: { packaged: boolean; selftest: boolean; inOerba: boolean }): boolean {
  return s.packaged && !s.selftest && s.inOerba;
}

/** A version the app may take: three numbers, as electron-builder writes them. No prerelease tail: electron-updater's
    allowPrerelease only chooses which GitHub release it reads, and would take a tail a feed wrote. */
export const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?![\s\S])/;

/** Whether version a is newer than b, both three numbers; false for anything else. */
export function newer(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** What a downloaded update must be before it is handed to macOS's installer, which checks only that it is signed by the
    same team: a zip of this app's bundle alone (every entry under `<bundle>/`), whose own Info.plist names this app and the
    version the feed offered, newer than the one running. So a validly signed older build, or another of the team's apps, sent
    under a newer version's name, is refused before it can be installed. Null when it may go on, or why not. */
export function updateZipRefusal(z: { entries: string[]; version: string | null; id: string | null }, expect: { bundle: string; id: string; version: string; current: string }): string | null {
  if (z.entries.length === 0) return "the update holds nothing";
  if (!z.entries.every((e) => e.startsWith(`${expect.bundle}/`))) return "the update holds more than this app";
  if (z.id !== expect.id) return "the update is another app";
  if (z.version !== expect.version) return "the update's version is not the one offered";
  if (!newer(z.version, expect.current)) return "the update is not newer than this version";
  return null;
}

/** Whether the app downloads an offered version by itself: always, but for one whose download or check failed in the last day. */
export function mayDownloadAlone(s: { version: string; failed: { version: string; at: number } | null; now: number }): boolean {
  return !(s.failed && s.failed.version === s.version && s.now - s.failed.at < RETRY_AFTER_MS);
}

export type Phase = "none" | "available" | "downloading" | "ready" | "failed";

export interface UpdateState { phase: Phase; version: string; notes: string; percent: number; problem: string }
export const noUpdate = (): UpdateState => ({ phase: "none", version: "", notes: "", percent: 0, problem: "" });

export type UpdateEvent =
  | { type: "found"; version: unknown; notes: string }
  | { type: "download" }
  | { type: "progress"; percent: number }
  | { type: "downloaded" }
  | { type: "error" };

/** Moves the state on. A version that is not plain is not offered, and so never downloaded; the download starts only from
    "available" (the app starts it once a plain version is found) or "failed" (a press of Download, or the next find), and
    nothing here installs: a restart is the person's press, or the app's own when mayRestartAlone says so. */
export function step(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case "found":
      if (typeof e.version !== "string" || !VERSION.test(e.version)) return s;
      if (s.phase === "downloading" || s.phase === "ready") return s;
      return { phase: "available", version: e.version, notes: e.notes, percent: 0, problem: "" };
    case "download":
      return s.phase === "available" || s.phase === "failed" ? { ...s, phase: "downloading", percent: 0, problem: "" } : s;
    case "progress":
      return s.phase === "downloading" ? { ...s, percent: Math.max(0, Math.min(100, Math.round(e.percent))) } : s;
    case "downloaded":
      return s.phase === "downloading" ? { ...s, phase: "ready", percent: 100 } : s;
    case "error":
      return s.phase === "downloading" ? { ...s, phase: "failed", problem: "The update did not download, or did not pass its checks. Nothing was changed." } : s;
  }
}

/** Whether the person's press may start the download or the restart, given where the state is. */
export const canDownload = (s: UpdateState): boolean => s.phase === "available" || s.phase === "failed";
export const canRestart = (s: UpdateState): boolean => s.phase === "ready";
