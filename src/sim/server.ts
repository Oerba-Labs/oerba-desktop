/* Runs serve-sim for the iPhone panel: Expo's command, in a utility process of the app's own (Electron's Node, so no Node need be
   installed, and the RunAsNode fuse stays off), with the words of src/sim/serve.ts and nothing else. One at a time, for one device.
   It is started only by the app's own menu, through the panel (src/sim/panel.ts); no page, bridge or IPC starts it.

   While it runs, serve-sim arms a loader in the simulator (its launchd's DYLD_INSERT_LIBRARIES) for the whole session, and its
   capture reads the simulator's screen and sends it touches. Stopped with SIGINT, as Ctrl+C stops it, it takes the loader out
   again; if it is killed instead, the next start finds the loader left behind and takes it out first, and a reboot of the
   simulator clears it in any case. */

import { app, utilityProcess, type UtilityProcess } from "electron";
import http from "node:http";
import path from "node:path";
import { readyLine, serveSimArgs, serveSimEnv, SIM_PORT_FIRST } from "./serve";

/** How long a start may take: a simulator that has just booted can take a minute before serve-sim's capture is ready. */
const START_MS = 120_000;
/** How long a stop waits for serve-sim to take its loader out before the process is killed. */
const STOP_MS = 10_000;
/** What is kept of serve-sim's output while it starts: enough for its start-up lines, and no more. */
const KEEP = 64_000;

export type Started = { origin: string; port: number; token: string; udid: string } | { why: string };

/** Where serve-sim's command is: beside the app's own code in a development run, and in the app's Resources, outside app.asar,
    once packaged (its native addon, and the libraries it loads into the simulator, must be files the simulator can read). */
export function serveSimEntry(): string {
  const root = app.isPackaged ? path.join(process.resourcesPath, "serve-sim") : app.getAppPath();
  return path.join(root, "node_modules", "@expo", "serve-sim", "dist", "serve-sim.js");
}

/** Whether serve-sim's preview answers `/readyz` with 200: asked on loopback, with no credential (it is open by design). */
function ready(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/readyz", timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

/** What the panel needs of a serve-sim: the real one below, or the self-test's own, which starts nothing. */
export interface SimServing {
  readonly running: Extract<Started, { origin: string }> | null;
  readonly alive: boolean;
  start(udid: string): Promise<Started>;
  stop(): Promise<void>;
  /** Called when serve-sim stopped by itself after it had started (not by stop()): the panel then drops its preview. */
  onGone?: () => void;
}

export class SimServer implements SimServing {
  private child: UtilityProcess | null = null;
  private current: Extract<Started, { origin: string }> | null = null;
  private starting: Promise<Started> | null = null;
  /** Moved by every stop(): a start that was waiting for the last serve-sim to go does not go on to start one if a stop came
      meanwhile (the panel was closed during a switch of device). */
  private epoch = 0;
  onGone?: () => void;

  /** The running preview, if any. */
  get running(): Extract<Started, { origin: string }> | null { return this.current; }

  /** Whether serve-sim's process is there at all, ready or still starting. */
  get alive(): boolean { return this.child !== null; }

  /** Starts serve-sim for this device, or returns the one already running for it. A different device stops the first. */
  async start(udid: string): Promise<Started> {
    if (this.current?.udid === udid && this.child) return this.current;
    if (this.starting) return { why: "the iPhone panel is still starting" };
    const e = this.epoch;
    this.starting = (async (): Promise<Started> => {
      await this.halt();
      return this.epoch === e ? this.spawn(udid) : { why: "the panel was closed while it started" };
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  private spawn(udid: string): Promise<Started> {
    const args = serveSimArgs(udid, SIM_PORT_FIRST);
    if (args === null) return Promise.resolve({ why: "that simulator could not be named" });
    return new Promise((resolve) => {
      let child: UtilityProcess;
      try {
        child = utilityProcess.fork(serveSimEntry(), args, { stdio: "pipe", serviceName: "Oerba iPhone panel", env: serveSimEnv(process.env) });
      } catch {
        resolve({ why: "its helper could not be started" });
        return;
      }
      this.child = child;
      let seen = "";
      let done = false;
      const finish = (r: Started): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if ("origin" in r) this.current = r;
        resolve(r);
      };
      const timer = setTimeout(() => { finish({ why: "it did not start in time" }); void this.stop(); }, START_MS);
      let matched = false;
      const onData = (chunk: Buffer): void => {
        if (done || matched) return;
        seen = (seen + chunk.toString("utf8")).slice(-KEEP);
        const r = readyLine(seen);
        if (r === null) return;
        // The first Local line is the one: nothing serve-sim prints afterwards moves the origin or the token.
        matched = true;
        seen = "";   // the token is not kept beyond what it is needed for
        const poll = async (): Promise<void> => {
          while (!done) {
            if (await ready(r.port)) { finish({ origin: `http://127.0.0.1:${r.port}`, port: r.port, token: r.token, udid }); return; }
            await new Promise((t) => setTimeout(t, 250));
          }
        };
        void poll();
      };
      child.stdout?.on("data", onData);
      // serve-sim's start-up notes go to its standard error; they are drained and not kept.
      child.stderr?.on("data", () => undefined);
      child.on("exit", () => {
        // stop() lets go of the child before it signals it, so a child still held here stopped by itself.
        const unasked = this.child === child;
        if (unasked) { this.child = null; this.current = null; }
        if (done && unasked) this.onGone?.();
        finish({ why: "its helper stopped while starting" });
      });
    });
  }

  /** Stops serve-sim, and any start still waiting to begin one. */
  async stop(): Promise<void> {
    this.epoch++;
    await this.halt();
  }

  /** Stops the running serve-sim: SIGINT first, so that it takes its loader out of the simulator, then a kill if it has not gone
      in time. */
  private async halt(): Promise<void> {
    const child = this.child;
    this.current = null;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      let gone = false;
      const t = setTimeout(() => { if (!gone) child.kill(); resolve(); }, STOP_MS);
      child.once("exit", () => { gone = true; clearTimeout(t); resolve(); });
      const pid = child.pid;
      try { if (pid !== undefined) process.kill(pid, "SIGINT"); else child.kill(); } catch { child.kill(); }
    });
  }
}
