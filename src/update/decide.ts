/* When the app asks for an update, and what it does with an answer. Pure. */

/** How often an update is looked for, once the person is in; the Mac's waking from sleep asks too. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;

/** How long a downloaded update waits for the person to restart before the app restarts itself, when they are away. */
export const READY_GRACE_MS = 24 * 60 * 60 * 1000;

/** Away: the Mac has had no input for this long (seconds), or its screen is locked. */
export const AWAY_IDLE_S = 7 * 60;

/** How often the app asks whether it may restart itself for an update. */
export const AWAY_POLL_MS = 60 * 1000;

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

/** A version the app may show: three numbers, as electron-builder writes them (a prerelease tail is allowed and is plain). */
export const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,20})?(?![\s\S])/;

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
      return s.phase === "downloading" ? { ...s, phase: "failed", problem: "The download did not finish. Nothing was changed." } : s;
  }
}

/** Whether the person's press may start the download or the restart, given where the state is. */
export const canDownload = (s: UpdateState): boolean => s.phase === "available" || s.phase === "failed";
export const canRestart = (s: UpdateState): boolean => s.phase === "ready";
