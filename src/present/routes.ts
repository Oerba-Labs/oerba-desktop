/* Where the app sends Oerba's page: a hash route on app.oerba.dev, built from checked parts only. Pure. */

import { plainName } from "./text";

export const HOME = "#/";
export const CHAT = "#/chat";

/** A workspace's page on its card, `#/workspaces/card/<owner>/<name>`, or null for a name that is not plain. */
export function workspaceRoute(owner: unknown, name: unknown): string | null {
  const o = plainName(owner);
  const n = plainName(name);
  return o === null || n === null ? null : `#/workspaces/card/${encodeURIComponent(o)}/${encodeURIComponent(n)}`;
}

const SAFE_ROUTE = /^#\/[A-Za-z0-9._@%~/-]{0,300}(?![\s\S])/;

/** Only a route this module could have made is ever put in a page's address. */
export const safeRoute = (route: unknown): route is string => typeof route === "string" && SAFE_ROUTE.test(route) && !route.includes("..");
