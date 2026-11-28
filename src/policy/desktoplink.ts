/* What Oerba's own page may ask of this app, and how: a link of the app's own scheme, opened by window.open from a button that Oerba
   draws only when the app names itself in its User-Agent (OerbaDesktop/<version>). The window handler takes it only from Oerba's
   own top frame, just after a press, under the link-out gate's rules (src/shell/hardening.ts), so a workspace's frame never can, and
   the page never gets a bridge. Pure: no Electron.

   One thing may be asked: `oerba-desktop:dev-panel`, the dev panel opened or closed, as the menus' Dev Panel does, with at most a
   workspace named, `?workspace=<owner>/<name>` in On-Demand's own name pattern, whose app is opened in it when its Metro is running
   (the main process checks it is one of the person's own running workspaces). Anything else of the scheme is refused. */

import { upstreamName } from "../relay/rules";

export const DESKTOP_SCHEME = "oerba-desktop:";

/** The token the app adds to Oerba's view's User-Agent, by which Oerba's page knows to draw the Dev Panel button. */
export const desktopToken = (version: string): string => `OerbaDesktop/${version}`;

export interface DesktopAsk { action: "dev-panel"; workspace: { owner: string; name: string } | null }

/** What a window.open address asks of the app: null when it is not of the app's scheme (the link-out rules apply), "refused" when
    it is but asks for anything else or is not of the shape, and the ask otherwise. */
export function desktopLink(url: string): DesktopAsk | "refused" | null {
  if (typeof url !== "string" || !url.toLowerCase().startsWith(DESKTOP_SCHEME)) return null;
  if (url.length > 200) return "refused";
  let u: URL;
  try { u = new URL(url); } catch { return "refused"; }
  if (u.protocol !== DESKTOP_SCHEME || u.pathname !== "dev-panel" || u.hash !== "" || u.username !== "" || u.password !== "" || u.host !== "") return "refused";
  const keys = [...u.searchParams.keys()];
  if (keys.length === 0) return { action: "dev-panel", workspace: null };
  if (keys.length !== 1 || keys[0] !== "workspace") return "refused";
  const parts = (u.searchParams.get("workspace") ?? "").split("/");
  if (parts.length !== 2) return "refused";
  const [owner = "", name = ""] = parts;
  // On-Demand's own pattern, as the forwards hold a workspace to it (any Metro port stands for the check).
  if (upstreamName(8081, name, owner) === null) return "refused";
  return { action: "dev-panel", workspace: { owner, name } };
}

/** The fixed script that tells Oerba's page whether the dev panel is open, as an event it may listen for. It holds nothing from
    anywhere: one of two strings. */
export const devPanelStateJs = (open: boolean): string =>
  open ? 'window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: true } }))'
    : 'window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: false } }))';
