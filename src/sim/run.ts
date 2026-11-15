/* Runs the Xcode tools for "Open in iOS Simulator", one press at a time. Every command is a fixed absolute program with fixed words,
   never a shell, with a timeout and a bounded output; the only variable parts are a UDID held to a UUID's shape and a port held to an
   integer, both checked again here. It starts only from the app's own menu (presence.ts): no bridge, IPC or page reaches it.
   Booting a simulator is the only thing it changes on the Mac: it never erases, shuts down, creates or deletes one, and installs no app. */

import { execFile } from "node:child_process";
import { DEVICE_HUB_ID, deviceHubUrl, EXPO_GO, expoUrl, isUdid, parseDevices, pickDevice, SIMULATOR_ID, type Outcome } from "./decide";

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

/** The whole sequence for a forward that took `port` here. Read-only until it boots a simulator. */
export async function openInSimulator(port: number, run: Runner): Promise<Outcome> {
  const url = expoUrl(port);
  if (url === null) return { kind: "failed" };

  // Xcode itself, not only the command line tools: `xcode-select -p` first, since `xcrun` with no tools at all offers to install some.
  if ((await run(XCODE_SELECT, ["-p"], QUICK)).code !== 0) return { kind: "no-xcode" };
  if ((await run(XCRUN, ["--find", "simctl"], QUICK)).code !== 0) return { kind: "no-xcode" };

  const list = await run(XCRUN, ["simctl", "list", "devices", "--json"], LIST);
  if (list.code !== 0) return { kind: "failed" };
  const pick = pickDevice(parseDevices(list.stdout));
  if (pick.kind === "none") return { kind: "no-iphone" };
  const { udid, name } = pick.device;
  if (!isUdid(udid)) return { kind: "failed" };

  if (pick.kind === "boot") {
    if ((await run(XCRUN, ["simctl", "boot", udid], QUICK)).code !== 0) return { kind: "boot-failed" };
    // Boots asynchronously: wait until it is up (this reads, it changes nothing), or the address would meet a device not ready for it.
    if ((await run(XCRUN, ["simctl", "bootstatus", udid], BOOT)).code !== 0) return { kind: "boot-failed" };
  }
  // Shows the device: in Device Hub (Xcode 27) by its bundle id and deep link, else in Simulator (Xcode 26 and earlier) by its bundle id.
  // If neither opens, that does not stop the address being opened, and is said at the end.
  const hub = deviceHubUrl(udid);
  const shown = (hub !== null && (await run(OPEN, ["-b", DEVICE_HUB_ID, hub], QUICK)).code === 0) ||
    (await run(OPEN, ["-b", SIMULATOR_ID, "--args", "-CurrentDeviceUDID", udid], QUICK)).code === 0;

  if ((await run(XCRUN, ["simctl", "get_app_container", udid, EXPO_GO], QUICK)).code !== 0) return { kind: "no-expo-go", name };
  if ((await run(XCRUN, ["simctl", "openurl", udid, url], QUICK)).code !== 0) return { kind: "open-failed", name };
  return { kind: "opened", name, booted: pick.kind === "boot", port, shown };
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
