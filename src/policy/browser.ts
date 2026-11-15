/* The one address the app opens in the system browser on its own account: a forward's own `http://localhost:<n>/`, for a forward
   running now, on the menu press that started it. The general link-out rule (linkout.ts) is not touched by this: it still sends
   only a page's https links, and a page's request, /api/now and a workspace's words never reach this function. Pure. */

/** The ports that are web servers: starting a forward of one opens the browser. Metro's and Expo's (8081, 19000, 19006) notify instead,
    since the Simulator reads them. */
export const WEB_PORTS: readonly number[] = [3000, 5173, 8000, 8080];
export const NOTIFY_PORTS: readonly number[] = [8081, 19000, 19006];

/** The address the app itself builds for the number a forward took. */
export const localAddress = (local: number): string => `http://localhost:${local}/`;

/** The address, if it is exactly `http://localhost:<n>/` (no credentials, path or query) for a forward running now; else null. */
export function approvedOpen(address: unknown, running: readonly { local: number }[]): string | null {
  if (typeof address !== "string") return null;
  const m = /^http:\/\/localhost:([1-9][0-9]{0,4})\/(?![\s\S])/.exec(address);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 65535 && running.some((f) => f.local === n) ? address : null;
}
