/* The dev panel's helper, Expo's serve-sim (`@expo/serve-sim`, Apache-2.0), as rules: the words it is started with, how its
   address and token are read from what it prints, and which page the panel may show. Pure: nothing here starts a process
   (src/sim/server.ts does) or touches a view (src/sim/panel.ts does), so a test can read every decision. */

import { isPort, isUdid } from "./decide";

/** The version the app carries, pinned in package.json's devDependencies; the tests hold the two to each other. */
export const SERVE_SIM_VERSION = "0.14.6";


/** The words serve-sim's command is given. Always:
    - its token gate (`--require-token`): without it, any page on localhost may read the preview, and the relay serves
      workspaces' pages on localhost;
    - loopback alone (`--host 127.0.0.1`, its default, said again so that a change of default cannot widen it);
    - one device (`--single-device`), the one the press used;
    - no clipboard reader (`--disable clipboard`): its default loads a library into every app of the simulator, Safari's
      included, to read their pasteboard;
    - no Share button (`--disable-share`): the panel is this Mac's alone.
    No port: given one, serve-sim tries that port alone and stops if it is taken (by another serve-sim, or a workspace's port
    Oerba forwards to the same number); given none, it tries 3200 and the next 49, and says which it took (readyLine).
    Nothing a workspace, a page or Oerba's API said is in them: the UDID is held to a UUID's shape. Null for anything else. */
export function serveSimArgs(udid: unknown): string[] | null {
  if (!isUdid(udid)) return null;
  return ["--require-token", "--host", "127.0.0.1", "--single-device", udid, "--disable", "clipboard", "--disable-share", udid];
}

/** The environment serve-sim runs in, built rather than inherited. serve-sim reads variables that would load further libraries
    into the simulator (`SERVE_SIM_ADDITIONAL_DYLIBS`, its helpers' folder `SERVE_SIM_SIMPB_DIR`) and simctl hands every
    `SIMCTL_CHILD_*` on to the simulator's apps, so none of the app's own environment passes but the account's names and folders,
    a fixed PATH, and the person's choice of Xcode (`DEVELOPER_DIR`, when it is an absolute path), as simctl itself would read. */
export function serveSimEnv(from: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1" };
  for (const k of ["HOME", "TMPDIR", "USER", "LOGNAME"] as const) {
    const v = from[k];
    if (typeof v === "string" && v !== "" && !v.includes("\0")) env[k] = v;
  }
  const dev = from["DEVELOPER_DIR"];
  if (typeof dev === "string" && dev.startsWith("/") && !dev.includes("\0")) env["DEVELOPER_DIR"] = dev;
  return env;
}

/** What serve-sim prints once its preview listens: `Local:   http://localhost:<port>/?token=<token>`. The port it took and its
    token, or null until that line has been printed. The token is held to the characters serve-sim mints (letters, digits and
    `-._~`, which travel unchanged in a header, a query, a cookie and a subprotocol) and to a sane length, and must end the
    line's address: whitespace, a terminal's colour code or the end of what was printed follows it. */
export function readyLine(text: string): { port: number; token: string } | null {
  const m = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):([0-9]{2,5})\/\?token=([A-Za-z0-9._~-]{16,256})(?![^\s\x1b])/.exec(text);
  if (!m) return null;
  const port = Number(m[1]);
  return isPort(port) && port >= 1024 ? { port, token: m[2]! } : null;
}

/** The panel's one origin: serve-sim's preview, on this Mac's loopback, at the port it took. */
export const simOrigin = (port: number): string => `http://127.0.0.1:${port}`;

/** The address the panel first loads: the preview with its token, which serve-sim turns into a cookie of that origin and a
    redirect that drops it from the address. The cookie lives in the panel's own in-memory session alone. */
export const previewUrl = (port: number, token: string): string => `${simOrigin(port)}/?token=${encodeURIComponent(token)}`;

/** Whether a URL is serve-sim's preview: exactly its origin, no credentials in the address. False while no preview runs. */
export function isSimPage(url: string, origin: string | null): boolean {
  if (origin === null) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.origin === origin && u.username === "" && u.password === "";
}

/** Whether the preview may make a request: only to serve-sim's own origin (its page, its API and its websockets, the same host and
    port over http or ws), or to a blob of that origin, or a data: URL, which reach no network. Its page is serve-sim's own code,
    which draws strings the workspace's app controls (its logs, its labels): were any of them to run as script, it could reach
    nowhere else with the token it holds. False while no preview runs. */
export function previewRequestAllowed(url: string, origin: string | null): boolean {
  if (origin === null) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "data:") return true;
  if (u.protocol === "blob:") return previewRequestAllowed(u.pathname, origin) && new URL(u.pathname).origin === origin;
  if (u.username !== "" || u.password !== "") return false;
  const o = new URL(origin);
  return (u.protocol === "http:" || u.protocol === "ws:") && u.host === o.host;
}

/** The panel's width beside Oerba's page: enough for an iPhone at a useful size and serve-sim's controls, and never more than
    half the window, so Oerba's page keeps the larger part. */
export function panelWidth(windowWidth: number): number {
  return Math.max(0, Math.min(440, Math.floor(windowWidth / 2)));
}

/** The panel's own bar, above the preview: the device's name and Close. */
export const BAR_HEIGHT = 36;
