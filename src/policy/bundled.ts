/* The app's own pages are served by a scheme of the app's own, `oerba-app://app/...`, from a fixed list of files, and not
   from file://. With the fuse that takes file:// pages' extra privileges away, a page inside app.asar does not load by
   file:// at all; and a fixed list means a page cannot ask the handler for anything else in the package. Pure. */

export const SCHEME = "oerba-app";
export const HOST = "app";
export const SETUP_URL = `${SCHEME}://${HOST}/setup/setup.html`;
export const UPDATE_URL = `${SCHEME}://${HOST}/update/update.html`;
export const SIMBAR_URL = `${SCHEME}://${HOST}/simbar/simbar.html`;

const FILES: Record<string, string> = {
  "/setup/setup.html": "text/html; charset=utf-8",
  "/setup/setup.css": "text/css; charset=utf-8",
  "/setup/setup.js": "text/javascript; charset=utf-8",
  "/update/update.html": "text/html; charset=utf-8",
  "/update/update.css": "text/css; charset=utf-8",
  "/update/update.js": "text/javascript; charset=utf-8",
  "/simbar/simbar.html": "text/html; charset=utf-8",
  "/simbar/simbar.css": "text/css; charset=utf-8",
  "/simbar/simbar.js": "text/javascript; charset=utf-8",
};

/** The file (relative to the app's folder) and type for a request URL of the scheme, or null for anything not on the list. */
export function bundledFile(url: string): { relative: string; type: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST || u.username !== "" || u.password !== "") return null;
  const type = FILES[u.pathname];
  return type === undefined ? null : { relative: u.pathname.slice(1), type };
}
