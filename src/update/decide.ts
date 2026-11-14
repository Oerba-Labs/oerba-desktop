/* When the app asks for an update, and what it does with an answer. Pure. */

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

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

/** Moves the state on. A version that is not plain is not offered; the download starts only from "available" (the person's
    press), and nothing here installs: the restart is a separate press the window sends. */
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
