/* Serving the app's own pages by oerba-app://, from the fixed list in src/policy/bundled.ts, read with the main process's
   own file access (which reads inside app.asar). */

import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bundledFile, SCHEME } from "../policy/bundled";

/** Before the app is ready: the scheme is standard and secure, so the pages have an origin and a Content-Security-Policy that works. */
export function declareBundledScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

/** After it is ready: answers requests of the scheme, and nothing else of the package. */
export function serveBundled(root: string): void {
  protocol.handle(SCHEME, async (request) => {
    const f = bundledFile(request.url);
    if (f === null) return new Response("not found", { status: 404 });
    try {
      const body = await readFile(path.join(root, f.relative));
      return new Response(new Uint8Array(body), { headers: { "content-type": f.type, "cache-control": "no-store" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
