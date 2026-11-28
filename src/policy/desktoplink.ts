/* What Oerba's own page may ask of this app, and how: a link of the app's own scheme, opened by window.open from a button that Oerba
   draws only when the app names itself in its User-Agent (OerbaDesktop/<version>). The page never gets a bridge.

   Which frame called window.open, Electron does not say, and a workspace's frame inside Oerba's page can take the focus (top.focus())
   or call just after a press of the person's in Oerba's own page, so neither the focus nor the press tells the two apart. What does
   is a key: a random one of this run of the app's, given only to Oerba's own top frame, in the event that tells it the panel's state
   (below), where a frame of another origin cannot read it. An ask must carry it, and is then taken only just after a press, under the
   link-out gate's rules (src/shell/hardening.ts). Pure: no Electron.

   One thing may be asked: `oerba-desktop:dev-panel`, the dev panel opened or closed, as the menus' Dev Panel does, with at most a
   workspace named, `workspace=<owner>/<name>` in On-Demand's own name pattern, whose app is opened in it when its Metro is running
   (the main process checks it is one of the person's own running workspaces); and `key=<the key>`, always. Anything else of the
   scheme is refused. */

import { randomBytes } from "node:crypto";
import { upstreamName } from "../relay/rules";

export const DESKTOP_SCHEME = "oerba-desktop:";

/** The token the app adds to Oerba's view's User-Agent, by which Oerba's page knows to draw the Dev Panel button. */
export const desktopToken = (version: string): string => `OerbaDesktop/${version}`;

export interface DesktopAsk { action: "dev-panel"; workspace: { owner: string; name: string } | null; key: string }

const KEY = /^[0-9a-f]{32}$/;

/** A new key, for one run of the app: 128 random bits, as hex. */
export const newDesktopKey = (): string => randomBytes(16).toString("hex");

/** What a window.open address asks of the app: null when it is not of the app's scheme (the link-out rules apply), "refused" when
    it is but asks for anything else or is not of the shape, and the ask otherwise. */
export function desktopLink(url: string): DesktopAsk | "refused" | null {
  if (typeof url !== "string" || !url.toLowerCase().startsWith(DESKTOP_SCHEME)) return null;
  if (url.length > 200) return "refused";
  let u: URL;
  try { u = new URL(url); } catch { return "refused"; }
  if (u.protocol !== DESKTOP_SCHEME || u.pathname !== "dev-panel" || u.hash !== "" || u.username !== "" || u.password !== "" || u.host !== "") return "refused";
  const names = [...u.searchParams.keys()];
  if (names.some((n) => n !== "key" && n !== "workspace") || new Set(names).size !== names.length) return "refused";
  const key = u.searchParams.get("key") ?? "";
  if (!KEY.test(key)) return "refused";
  if (!u.searchParams.has("workspace")) return { action: "dev-panel", workspace: null, key };
  const parts = (u.searchParams.get("workspace") ?? "").split("/");
  if (parts.length !== 2) return "refused";
  const [owner = "", name = ""] = parts;
  // On-Demand's own pattern, as the forwards hold a workspace to it (any Metro port stands for the check).
  if (upstreamName(8081, name, owner) === null) return "refused";
  return { action: "dev-panel", workspace: { owner, name }, key };
}

/** The script that tells Oerba's page whether the dev panel is open, and the key its asks must carry, as an event it may listen
    for. It holds nothing any page or workspace said: a boolean and the app's own key, which must be of the key's shape. */
export function devPanelStateJs(open: boolean, key: string): string {
  if (!KEY.test(key)) throw new Error("not a key");
  return `window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: ${open ? "true" : "false"}, key: "${key}" } }))`;
}
