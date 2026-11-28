/* The menu bar item's menu as plain data, so a test can read it and the main process can build it. Pure. */

import type { NowModel } from "./now";
import { CHAT, HOME, workspaceRoute } from "./routes";
import { COMMON_PORTS, type ForwardInfo } from "../relay/manager";
import { upstreamName } from "../relay/rules";
import { METRO_PORTS } from "../sim/decide";
import { wsKey } from "./ports";

export type Action =
  | { type: "open" }
  | { type: "route"; route: string }
  | { type: "palette" }
  | { type: "forward"; owner: string; name: string; port: number }
  | { type: "simulator"; owner: string; name: string; port: number }
  | { type: "device"; udid: string }
  | { type: "dev-panel" }
  | { type: "forget-allowed" }
  | { type: "stop"; id: string }
  | { type: "login"; checked: boolean }
  | { type: "update" }
  | { type: "restart" }
  | { type: "quit" };

export interface MenuItem {
  label: string;
  kind?: "item" | "separator" | "checkbox";
  enabled?: boolean;
  checked?: boolean;
  action?: Action;
  submenu?: MenuItem[];
}

export interface MenuInput {
  /** The person is in: Oerba's pages are showing and /api/now has been read at least once. */
  inOerba: boolean;
  now: NowModel | null;
  loginItem: boolean;
  /** Whether each global shortcut was free and registered. */
  paletteKey: boolean;
  chatKey: boolean;
  /** An update found (its version, already checked to be plain) and whether it is downloaded and ready, or null. */
  update: { version: string; ready: boolean } | null;
  /** The localhost forwards running now (src/relay/), shown under their workspaces. */
  forwards?: ForwardInfo[];
  /** The ports each workspace is listening on, as On-Demand last said (src/present/ports.ts), by wsKey. A workspace not in it
      (not read yet, or On-Demand not reached) is offered the usual ports, as before. */
  listening?: ReadonlyMap<string, readonly number[]>;
  /** The dev panel, where this app has one: whether it is open, and how many workspaces the person has let run in the simulator.
      Absent, no Dev Panel item. */
  devPanel?: { open: boolean; allowed?: number };
}

const SEP: MenuItem = { label: "", kind: "separator" };
const MAX_LISTED = 15;
/** The most listening ports offered for one workspace. */
const MAX_PORT_ITEMS = 12;
const STARTED = /^(running|starting|pending)$/;

export function buildMenu(i: MenuInput): MenuItem[] {
  const items: MenuItem[] = [{ label: "Open Oerba", action: { type: "open" } }];
  // A ready update restarts at once, from here; one still downloading (or whose download failed) opens the update window.
  if (i.update?.ready) items.push({ label: `Restart to Update to ${i.update.version}`, action: { type: "restart" } });
  else if (i.update) items.push({ label: `Update to ${i.update.version}…`, action: { type: "update" } });
  if (i.inOerba) {
    items.push(SEP);
    const started = (i.now?.workspaces ?? []).filter((w) => STARTED.test(w.status));
    const rows: MenuItem[] = [];
    for (const w of started) {
      const route = workspaceRoute(w.owner, w.name);
      if (route === null || rows.length >= MAX_LISTED) continue;
      // The workspace's page, then its ports on this Mac's localhost: those running (and the number each took), then those to start.
      const mine = (i.forwards ?? []).filter((f) => f.owner === w.owner && f.name === w.name);
      const sub: MenuItem[] = [{ label: "Open in Oerba", action: { type: "route", route } }];
      const running = new Set(mine.map((f) => f.remote));
      // The ports it is listening on, when On-Demand has said; the usual ones otherwise.
      const known = i.listening?.get(wsKey(w.owner, w.name));
      const offer = (known ? known.slice(0, MAX_PORT_ITEMS) : COMMON_PORTS).filter((p) => !running.has(p) && upstreamName(p, w.name, w.owner) !== null);
      if (mine.length > 0 || offer.length > 0) sub.push(SEP);
      for (const f of mine) sub.push({ label: `localhost:${f.local} → ${f.remote} (stop)`, action: { type: "stop", id: f.id } });
      for (const p of offer) sub.push({ label: `Open on localhost:${p}`, action: { type: "forward", owner: w.owner, name: w.name, port: p } });
      // Metro's ports also open in the iOS Simulator on this Mac (src/sim/): it starts the forward itself if it is not running.
      for (const p of METRO_PORTS.filter((n) => !known || known.includes(n))) {
        if (upstreamName(p, w.name, w.owner) !== null) sub.push({ label: `Open ${p} in iOS Simulator`, action: { type: "simulator", owner: w.owner, name: w.name, port: p } });
      }
      rows.push({ label: mine.length > 0 ? `${w.name} (localhost:${mine.map((f) => f.local).join(", ")})` : w.name, submenu: sub });
    }
    items.push(rows.length > 0 ? { label: "Workspaces", submenu: rows } : { label: "Workspaces", enabled: false });
    // The dev panel on its own, with or without an app: ticked while it is open, and choosing it then closes it.
    if (i.devPanel) items.push({ label: "Dev Panel", kind: "checkbox", checked: i.devPanel.open, action: { type: "dev-panel" } });
    // The person's yes, each workspace's, to run its code in the simulator, let go at once: each is asked again (0.6.3).
    if (i.devPanel?.allowed) items.push({ label: `Forget Workspaces Allowed in Simulator (${i.devPanel.allowed})`, action: { type: "forget-allowed" } });
    if (i.now?.isOwner) items.push({ label: `Waiting on you (${i.now.needs.length})`, action: { type: "route", route: HOME } });
    items.push({ label: "New chat", action: { type: "route", route: CHAT } });
    items.push({ label: "Switch workspace…", action: { type: "palette" } });
  }
  items.push(SEP);
  items.push({ label: "Open at login", kind: "checkbox", checked: i.loginItem, action: { type: "login", checked: !i.loginItem } });
  // A shortcut another app holds is said here, quietly, and not as an error.
  if (!i.paletteKey) items.push({ label: "⌥Space is used by another app", enabled: false });
  if (!i.chatKey) items.push({ label: "⌥⇧Space is used by another app", enabled: false });
  items.push(SEP);
  items.push({ label: "Quit Oerba", action: { type: "quit" } });
  return items;
}

/** The labels of a menu, flattened, for the self-test to read. */
export const labelsOf = (items: MenuItem[]): string[] => items.flatMap((m) => (m.kind === "separator" ? [] : [m.label, ...(m.submenu ? labelsOf(m.submenu).map((l) => `  ${l}`) : [])]));
