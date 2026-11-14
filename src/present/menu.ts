/* The menu bar item's menu as plain data, so a test can read it and the main process can build it. Pure. */

import type { NowModel } from "./now";
import { CHAT, HOME, workspaceRoute } from "./routes";

export type Action =
  | { type: "open" }
  | { type: "route"; route: string }
  | { type: "palette" }
  | { type: "login"; checked: boolean }
  | { type: "update" }
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
  /** A version waiting to be offered, or null. */
  update: string | null;
}

const SEP: MenuItem = { label: "", kind: "separator" };
const MAX_LISTED = 15;
const STARTED = /^(running|starting|pending)$/;

export function buildMenu(i: MenuInput): MenuItem[] {
  const items: MenuItem[] = [{ label: "Open Oerba", action: { type: "open" } }];
  if (i.update !== null) items.push({ label: `Update to ${i.update}…`, action: { type: "update" } });
  if (i.inOerba) {
    items.push(SEP);
    const started = (i.now?.workspaces ?? []).filter((w) => STARTED.test(w.status));
    const rows: MenuItem[] = [];
    for (const w of started) {
      const route = workspaceRoute(w.owner, w.name);
      if (route !== null && rows.length < MAX_LISTED) rows.push({ label: w.name, action: { type: "route", route } });
    }
    items.push(rows.length > 0 ? { label: "Workspaces", submenu: rows } : { label: "Workspaces", enabled: false });
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
