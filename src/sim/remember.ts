/* Which device each workspace was last opened on, so that the next press, or the offer when its Metro starts, uses that device; and
   which device the dev panel last showed, which the panel opened on its own shows again.
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

/** The device the dev panel last showed, from the file's text, held to the same shape; null if there is none. */
export function parsePanelDevice(text: string): Remembered | null {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return null; }
  const e = typeof root === "object" && root !== null ? (root as { panel?: unknown }).panel : null;
  if (typeof e !== "object" || e === null) return null;
  const { udid, name } = e as Record<string, unknown>;
  return isUdid(udid) && typeof name === "string" && NAME.test(name) ? { udid, name } : null;
}

export const serialiseRemembered = (m: ReadonlyMap<string, Remembered>, panel: Remembered | null = null): string =>
  `${JSON.stringify({ workspaces: [...m].slice(-MAX_REMEMBERED).map(([key, r]) => ({ key, udid: r.udid, name: r.name })), ...(panel ? { panel: { udid: panel.udid, name: panel.name } } : {}) }, null, 1)}\n`;

export class DeviceMemory {
  private map: Map<string, Remembered> | null = null;
  private panelDevice: Remembered | null = null;

  /** `file` null keeps the memory in this process alone (the unit tests). */
  constructor(private readonly file: string | null) {}

  private load(): Map<string, Remembered> {
    if (this.map) return this.map;
    let text = "";
    if (this.file) { try { text = readFileSync(this.file, "utf8"); } catch { /* none yet */ } }
    this.map = parseRemembered(text);
    this.panelDevice = parsePanelDevice(text);
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
    this.save();
  }

  /** The device the dev panel last showed, whatever it showed on it. */
  getPanel(): Remembered | null {
    this.load();
    return this.panelDevice;
  }

  setPanel(r: Remembered): void {
    if (!isUdid(r.udid) || !NAME.test(r.name)) return;
    this.load();
    if (this.panelDevice?.udid === r.udid && this.panelDevice.name === r.name) return;
    this.panelDevice = { udid: r.udid, name: r.name };
    this.save();
  }

  /** Writes the file whole, by rename; a write that fails is let go (see set). */
  private save(): void {
    if (!this.file || !this.map) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, serialiseRemembered(this.map, this.panelDevice), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* kept in memory */ }
  }
}
