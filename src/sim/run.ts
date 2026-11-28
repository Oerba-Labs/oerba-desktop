/* Runs the Xcode tools for "Open in iOS Simulator", one press at a time. Every command is a fixed absolute program with fixed words,
   never a shell, with a timeout and a bounded output; the only variable parts are a UDID held to a UUID's shape and a port held to an
   integer, both checked again here. It starts only from the app's own menu (presence.ts): no bridge, IPC or page reaches it.
   Booting a simulator is the only thing it changes on the Mac: it never erases, shuts down, creates or deletes one, and installs no app. */

import { execFile } from "node:child_process";
import { DEVICE_HUB_ID, deviceHubUrl, EXPO_GO, expoUrl, isUdid, parseDevices, pickDevice, SIMULATOR_ID, type Device, type Outcome } from "./decide";

export interface Ran { code: number | null; stdout: string }
/** Runs one program. The self-test and the unit tests put a stand-in here; the app never does. */
export type Runner = (file: string, args: readonly string[], timeoutMs: number) => Promise<Ran>;

const XCRUN = "/usr/bin/xcrun";
const XCODE_SELECT = "/usr/bin/xcode-select";
const OPEN = "/usr/bin/open";
const QUICK = 15_000;
const LIST = 30_000;
const BOOT = 120_000;

/** Bounded: an output over 4 MB (the device list of a Mac with many simulators is about 100 kB) is an error, not memory. */
export const realRunner: Runner = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 4_000_000, windowsHide: true }, (err, stdout) => {
    const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
    resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
  });
});

/** How the menu's press runs its programs. The self-test replaces `run`; nothing else does. */
export const simulator = { run: realRunner };

/** Shows a device: in Device Hub (Xcode 27) by its bundle id and deep link, else in Simulator (Xcode 26 and earlier) by its bundle id.
    True if either opened. Only a press without the dev panel shows a device, which the app no longer makes. */
export async function showDevice(udid: string, run: Runner): Promise<boolean> {
  if (!isUdid(udid)) return false;
  const hub = deviceHubUrl(udid);
  return (hub !== null && (await run(OPEN, ["-b", DEVICE_HUB_ID, hub], QUICK)).code === 0) ||
    (await run(OPEN, ["-b", SIMULATOR_ID, "--args", "-CurrentDeviceUDID", udid], QUICK)).code === 0;
}

/** The Mac's available iOS simulators, read from simctl; it changes nothing. Xcode itself is asked for first, not only the command
    line tools: `xcode-select -p` before anything, since `xcrun` with no tools at all offers to install some. */
export async function listDevices(run: Runner): Promise<{ kind: "ok"; devices: Device[] } | { kind: "no-xcode" } | { kind: "failed" }> {
  if ((await run(XCODE_SELECT, ["-p"], QUICK)).code !== 0) return { kind: "no-xcode" };
  if ((await run(XCRUN, ["--find", "simctl"], QUICK)).code !== 0) return { kind: "no-xcode" };
  const list = await run(XCRUN, ["simctl", "list", "devices", "--json"], LIST);
  if (list.code !== 0) return { kind: "failed" };
  return { kind: "ok", devices: parseDevices(list.stdout) };
}

/** The device to use, booted and ready: `udid` when this Mac still has it, otherwise one picked (pickDevice). Read-only until it
    boots a simulator that was shut down. The dev panel opened on its own uses this alone; a press goes on to open the app. */
export async function readyDevice(run: Runner, udid: string | null): Promise<{ kind: "ready"; device: Device; booted: boolean } | { kind: "no-xcode" | "failed" | "no-iphone" | "boot-failed" }> {
  const listed = await listDevices(run);
  if (listed.kind !== "ok") return { kind: listed.kind };
  const pick = pickDevice(listed.devices, udid);
  if (pick.kind === "none") return { kind: "no-iphone" };
  if (!isUdid(pick.device.udid)) return { kind: "failed" };
  if (pick.kind === "boot") {
    if ((await run(XCRUN, ["simctl", "boot", pick.device.udid], QUICK)).code !== 0) return { kind: "boot-failed" };
    // Boots asynchronously: wait until it is up (this reads, it changes nothing), or the address would meet a device not ready for it.
    if ((await run(XCRUN, ["simctl", "bootstatus", pick.device.udid], BOOT)).code !== 0) return { kind: "boot-failed" };
  }
  return { kind: "ready", device: pick.device, booted: pick.kind === "boot" };
}

/** The whole sequence for a forward that took `port` here. Read-only until it boots a simulator. With `window` false the device is
    not shown in Device Hub: the dev panel shows it instead, once the sequence has opened the address. `udid` is the device to
    use when it is still on this Mac (one the dev panel listed or shows, or the one last used for this workspace); otherwise one is
    picked. */
export async function openInSimulator(port: number, run: Runner, opts: { window: boolean; udid?: string | null } = { window: true }): Promise<Outcome> {
  const url = expoUrl(port);
  if (url === null) return { kind: "failed" };

  const ready = await readyDevice(run, opts.udid ?? null);
  if (ready.kind !== "ready") return { kind: ready.kind };
  const { udid, name } = ready.device;
  // If the window does not open, that does not stop the address being opened, and is said at the end.
  const shown = opts.window ? await showDevice(udid, run) : true;

  if ((await run(XCRUN, ["simctl", "get_app_container", udid, EXPO_GO], QUICK)).code !== 0) return { kind: "no-expo-go", name };
  if ((await run(XCRUN, ["simctl", "openurl", udid, url], QUICK)).code !== 0) return { kind: "open-failed", name };
  return { kind: "opened", udid, name, booted: ready.booted, port, shown };
}

/** One press at a time: a press while another runs is ignored (false). */
export class OnePress {
  private busy = false;
  get running(): boolean { return this.busy; }
  async run<T>(f: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy) return { ran: false };
    this.busy = true;
    try { return { ran: true, value: await f() }; } finally { this.busy = false; }
  }
}
