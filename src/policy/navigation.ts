/* Where a page of the shell may go. Pure: no Electron, so a test can ask it anything. */

import { isSimPage } from "../sim/serve";

/** What a web contents is for: the bundled setup page, the update window, Oerba's live pages, the iPhone panel's bar (bundled) and
    its preview (serve-sim's page on this Mac's loopback), or (the self-test's stand-in) a stranger. */
export type Role = "setup" | "update" | "oerba" | "simbar" | "simulator" | "other";

export interface NavPolicy {
  /** Oerba's origin: https://app.oerba.dev, or a loopback one under the self-test. */
  oerbaOrigin: string;
  /** The bundled setup page's address (oerba-app://app/setup/setup.html), exactly. */
  setupUrl: string;
  /** The bundled update window's page, exactly. */
  updateUrl: string;
  /** The iPhone panel's bar, a bundled page, exactly. */
  simbarUrl: string;
  /** The origin of serve-sim's preview while the panel shows one (http://127.0.0.1:<port>), else null. Set by the panel alone. */
  simOrigin: string | null;
}

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

const plain = (u: URL): boolean => u.username === "" && u.password === "";

/** Whether a URL is the bundled setup page itself; a query or fragment is not part of what is compared. */
export function isBundledPage(url: string, bundledUrl: string): boolean {
  const u = parse(url);
  const s = parse(bundledUrl);
  return u !== null && s !== null && u.protocol === s.protocol && u.host === s.host && u.pathname === s.pathname && u.username === "" && u.password === "";
}

export const isSetupPage = (url: string, policy: NavPolicy): boolean => isBundledPage(url, policy.setupUrl);
export const isUpdatePage = (url: string, policy: NavPolicy): boolean => isBundledPage(url, policy.updateUrl);
export const isSimbarPage = (url: string, policy: NavPolicy): boolean => isBundledPage(url, policy.simbarUrl);

/** Whether a URL is Oerba's own: its origin, no credentials in the address. */
export function isOerbaPage(url: string, policy: NavPolicy): boolean {
  const u = parse(url);
  return u !== null && plain(u) && u.origin === policy.oerbaOrigin;
}

/** A frame inside a page: any name under oerba.dev (Oerba frames workspace doors), over https, on the default port. */
export function isOerbaFrame(url: string, policy: NavPolicy): boolean {
  const u = parse(url);
  if (u === null || !plain(u)) return false;
  if (u.origin === policy.oerbaOrigin) return true;
  return u.protocol === "https:" && u.port === "" && u.hostname.length > ".oerba.dev".length && u.hostname.endsWith(".oerba.dev");
}

/** The main frame of the setup view may only be the setup page; of Oerba's view, only Oerba. A stranger's goes nowhere. */
export function mainFrameAllowed(url: string, role: Role, policy: NavPolicy): boolean {
  if (role === "setup") return isSetupPage(url, policy);
  if (role === "update") return isUpdatePage(url, policy);
  if (role === "oerba") return isOerbaPage(url, policy);
  if (role === "simbar") return isSimbarPage(url, policy);
  // The preview may only be serve-sim's own page, at the one origin of the preview that is running now.
  if (role === "simulator") return isSimPage(url, policy.simOrigin);
  return false;
}

export function subframeAllowed(url: string, role: Role, policy: NavPolicy): boolean {
  // Only Oerba's view has frames. The setup page has none, nor the iPhone panel, and a stranger's may not make any.
  return role === "oerba" && isOerbaFrame(url, policy);
}

export function navigationAllowed(url: string, isMainFrame: boolean, role: Role, policy: NavPolicy): boolean {
  return isMainFrame ? mainFrameAllowed(url, role, policy) : subframeAllowed(url, role, policy);
}

/** An address that may be handed to the system browser: https only, with a host and no credentials. */
export function externalTarget(url: string): string | null {
  // The text must say https:// and then a host: the URL parser reads "https:///x" and "https:\\x" as a host of "x".
  if (!/^https:\/\/[^/\\]/i.test(url)) return null;
  const u = parse(url);
  if (u === null || u.protocol !== "https:" || u.hostname === "" || !plain(u)) return null;
  return u.href;
}

/** What window.open and a link that opens a new window turn into: always no new window, and the browser for https. */
export function openDecision(url: string): { action: "deny"; external: string | null } {
  return { action: "deny", external: externalTarget(url) };
}

/** Whether an IPC message came from the bundled setup page's own top frame. */
export function isSetupSender(frameUrl: string | undefined, isTopFrame: boolean, policy: NavPolicy): boolean {
  return isTopFrame && frameUrl !== undefined && isSetupPage(frameUrl, policy);
}

/** Whether an IPC message came from the iPhone panel's bundled bar, in its own top frame. */
export function isSimbarSender(frameUrl: string | undefined, isTopFrame: boolean, policy: NavPolicy): boolean {
  return isTopFrame && frameUrl !== undefined && isSimbarPage(frameUrl, policy);
}

/** Whether an IPC message came from the bundled update window's own top frame. */
export function isUpdateSender(frameUrl: string | undefined, isTopFrame: boolean, policy: NavPolicy): boolean {
  return isTopFrame && frameUrl !== undefined && isUpdatePage(frameUrl, policy);
}
