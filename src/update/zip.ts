/* Reads a downloaded update's zip before it is handed to macOS's installer: the names of its entries, and its bundle's own
   Info.plist, by macOS's unzip and plutil, run with fixed words and no shell. What it must be is decide.ts's
   (updateZipRefusal). Node alone, so the tests run it on real zips. */

import { spawn } from "node:child_process";
import { updateZipRefusal } from "./decide";

/** Runs a program of the system's, with input on its standard input if given. Its output, or null if it failed or ran long. */
function run(file: string, args: string[], input?: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { resolve(null); return; }
    const out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 60_000);
    child.stdout.on("data", (d: Buffer) => { size += d.length; if (size <= 8_000_000) out.push(d); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && size <= 8_000_000 ? Buffer.concat(out) : null); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

/** One string value of a plist (XML or binary), or null. */
async function plistValue(plist: Buffer, key: string): Promise<string | null> {
  const v = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", "-"], plist);
  return v === null ? null : v.toString("utf8").trim();
}

/** Why the zip may not be installed, or null when it may. */
export async function checkUpdateZip(zip: string, expect: { bundle: string; id: string; version: string; current: string }): Promise<string | null> {
  const list = await run("/usr/bin/unzip", ["-Z1", zip]);
  if (list === null) return "the update could not be read";
  const entries = list.toString("utf8").split("\n").filter((e) => e !== "");
  const plist = await run("/usr/bin/unzip", ["-p", zip, `${expect.bundle}/Contents/Info.plist`]);
  const id = plist && plist.length > 0 ? await plistValue(plist, "CFBundleIdentifier") : null;
  const version = plist && plist.length > 0 ? await plistValue(plist, "CFBundleShortVersionString") : null;
  return updateZipRefusal({ entries, version, id }, expect);
}
