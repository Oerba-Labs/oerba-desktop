/* Which device each workspace was last opened on, so that the next press, or the offer when its Metro starts, uses that device.
   Kept in one small file of the app's own (devices.json in its data folder, mode 0600), read and written whole, and held to its
   shape on the way in and out: at most MAX_REMEMBERED workspaces, each named `owner/workspace` in On-Demand's strict shape, each
   device a UUID-shaped UDID and a plain name. A file that is not that is read as empty, and nothing in it is ever run or opened:
   a remembered UDID is only a preference, used when simctl still lists it (pickDevice). */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isUdid } from "./decide";

export interface Remembered { udid: string; name: string }

export const MAX_REMEMBERED = 200;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/;
const NAME = /^[^\x00-\x1f\x7f]{1,60}(?![\s\S])/;

/** The key a workspace is remembered by, or null for a name not of On-Demand's shape. */
export function workspaceKey(owner: string, name: string): string | null {
  const k = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  return KEY.test(k) && k.length <= 130 ? k : null;
}

/** The file's text as a map, oldest first; anything not of the shape is left out, and a file that is not JSON is empty. */
export function parseRemembered(text: string): Map<string, Remembered> {
  const out = new Map<string, Remembered>();
  let root: unknown;
  try { root = JSON.parse(text); } catch { return out; }
  const list = typeof root === "object" && root !== null ? (root as { workspaces?: unknown }).workspaces : null;
  if (!Array.isArray(list)) return out;
  for (const e of list.slice(-MAX_REMEMBERED)) {
    if (typeof e !== "object" || e === null) continue;
    const { key, udid, name } = e as Record<string, unknown>;
    if (typeof key !== "string" || !KEY.test(key) || !isUdid(udid) || typeof name !== "string" || !NAME.test(name)) continue;
    out.delete(key);
    out.set(key, { udid, name });
  }
  return out;
}

export const serialiseRemembered = (m: ReadonlyMap<string, Remembered>): string =>
  `${JSON.stringify({ workspaces: [...m].slice(-MAX_REMEMBERED).map(([key, r]) => ({ key, udid: r.udid, name: r.name })) }, null, 1)}\n`;

export class DeviceMemory {
  private map: Map<string, Remembered> | null = null;

  /** `file` null keeps the memory in this process alone (the unit tests). */
  constructor(private readonly file: string | null) {}

  private load(): Map<string, Remembered> {
    if (this.map) return this.map;
    let text = "";
    if (this.file) { try { text = readFileSync(this.file, "utf8"); } catch { /* none yet */ } }
    this.map = parseRemembered(text);
    return this.map;
  }

  get(owner: string, name: string): Remembered | null {
    const k = workspaceKey(owner, name);
    return k === null ? null : this.load().get(k) ?? null;
  }

  /** Remembers a device for a workspace, as the newest entry; the oldest goes past MAX_REMEMBERED. A write that fails is let go:
      the device is remembered for this run and asked again next time. */
  set(owner: string, name: string, r: Remembered): void {
    const k = workspaceKey(owner, name);
    if (k === null || !isUdid(r.udid) || !NAME.test(r.name)) return;
    const m = this.load();
    m.delete(k);
    m.set(k, { udid: r.udid, name: r.name });
    while (m.size > MAX_REMEMBERED) m.delete(m.keys().next().value as string);
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, serialiseRemembered(m), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* kept in memory */ }
  }
}
