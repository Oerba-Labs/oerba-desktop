/* Where a page of the shell may go. Pure: no Electron, so a test can ask it anything. */

/** What a web contents is for: the bundled setup page, Oerba's live pages, or (the self-test's stand-in) a stranger. */
export type Role = "setup" | "oerba" | "other";

export interface NavPolicy {
  /** Oerba's origin: https://app.oerba.dev, or a loopback one under the self-test. */
  oerbaOrigin: string;
  /** The bundled setup page's file URL, exactly. */
  setupUrl: string;
}

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

const plain = (u: URL): boolean => u.username === "" && u.password === "";

/** Whether a URL is the bundled setup page itself; a query or fragment is not part of what is compared. */
export function isSetupPage(url: string, policy: NavPolicy): boolean {
  const u = parse(url);
  const s = parse(policy.setupUrl);
  return u !== null && s !== null && u.protocol === "file:" && u.host === "" && u.pathname === s.pathname;
}

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
  if (role === "oerba") return isOerbaPage(url, policy);
  return false;
}

export function subframeAllowed(url: string, role: Role, policy: NavPolicy): boolean {
  // Only Oerba's view has frames. The setup page has none, and a stranger's may not make any.
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
