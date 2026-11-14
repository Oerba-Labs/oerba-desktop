/* The localhost relay's rules, as pure functions: which requests a forward answers, what name it dials, and which headers go on.
   Nothing here touches a socket. The reasons are in SECURITY.md ("The localhost relay").

   The guard is against web pages. Any program on the Mac already reaches On-Demand's names as the person (the tailnet address
   is theirs), so the relay adds nothing for programs; what it must not do is let a page in the person's browser read from or
   write through a forward: DNS rebinding (a Host that is not ours), a cross-origin fetch (an Origin that is not ours, or
   Fetch Metadata saying cross-site) and a forged request are each refused before anything is dialled. */

export const UPSTREAM_SUFFIX = ".ondemand.oerba.dev";

/** A DNS label made of a name On-Demand accepts (its own nameRegex: letters and digits, single hyphens inside). */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/;

/** The name a forward dials, or null. Only a plain port number (four or five digits: On-Demand's own PortRegex, and it
    reserves the ports below 1024), a workspace and an owner of the strict shape, joined as On-Demand names a port's door:
    `<port>--<workspace>--<owner>.ondemand.oerba.dev`. A name with "--" inside, a dot, an underscore, an @ or anything else is
    refused, so no input can make the name end elsewhere or add a label. */
export function upstreamName(port: unknown, workspace: unknown, owner: unknown): string | null {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (typeof workspace !== "string" || typeof owner !== "string") return null;
  const w = workspace.toLowerCase(), o = owner.toLowerCase();
  if (!NAME.test(w) || !NAME.test(o)) return null;
  const label = `${port}--${w}--${o}`;
  if (label.length > 63) return null;   // a DNS label
  const name = label + UPSTREAM_SUFFIX;
  return name.endsWith(UPSTREAM_SUFFIX) && name.length <= 253 ? name : null;
}

/** A header's value as one string, or "" when absent. A repeated header counts as present with a joined value. */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(", ") : v ?? "");

export type Headers = Record<string, string | string[] | undefined>;

/** `Host` must be this forward's own: localhost, 127.0.0.1 or [::1], with its own number. This is the DNS-rebinding guard: a page
    at evil.example whose name was made to resolve to 127.0.0.1 sends Host: evil.example:<n>. */
export function hostAllowed(host: string | string[] | undefined, port: number): boolean {
  if (Array.isArray(host)) return false;
  const h = (host ?? "").toLowerCase();
  return h === `localhost:${port}` || h === `127.0.0.1:${port}` || h === `[::1]:${port}`;
}

/** `Origin`, when present, must be the forward's own page (the dev server's own pages), over http, on its own number. */
export function originAllowed(origin: string | string[] | undefined, port: number): boolean {
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  const o = origin.toLowerCase();
  return o === `http://localhost:${port}` || o === `http://127.0.0.1:${port}` || o === `http://[::1]:${port}`;
}

/** Fetch Metadata, mirroring On-Demand's own rule (`identityAllowedFor`, ondemandd/httpmw/trustedidentity.go): none, same-origin and
    none-site pass; any other (cross-site, same-site, a value not known) only as a top-level GET or HEAD navigation to a document. */
export function fetchSiteAllowed(headers: Headers, method: string): boolean {
  const site = one(headers["sec-fetch-site"]);
  if (site === "" || site === "same-origin" || site === "none") return true;
  return one(headers["sec-fetch-mode"]) === "navigate" && one(headers["sec-fetch-dest"]) === "document" && (method === "GET" || method === "HEAD");
}

export type Verdict = { ok: true } | { ok: false; status: number; why: string };

/** The three checks, in order, for a request or an upgrade. */
export function vet(headers: Headers, method: string, url: string | undefined, port: number): Verdict {
  if (!hostAllowed(headers["host"], port)) return { ok: false, status: 421, why: "host" };
  if (!originAllowed(headers["origin"], port)) return { ok: false, status: 403, why: "origin" };
  if (!fetchSiteAllowed(headers, method)) return { ok: false, status: 403, why: "fetch-site" };
  // Origin-form only: "/path?query". An absolute address, "*" or an authority would make the relay name somewhere itself.
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || /[\u0000- \u007f]/.test(url)) return { ok: false, status: 400, why: "target" };
  return { ok: true };
}

/** Headers that are never sent upstream: the browser's (Origin, Fetch Metadata, Cookie of every other localhost site), every
    credential (the relay holds none and a dev app's must not reach On-Demand's: its identity step and token reader read an
    Authorization: Bearer as an explicit session token, ondemandd/httpmw/trustedidentity.go hasExplicitToken and
    httpmw/apikey.go bearerToken, so it would be refused), On-Demand's session-token header, every Forwarded / X-Forwarded-* a
    client sent, the identity header's family, and the hop-by-hop headers. */
const NEVER = new Set([
  "origin", "cookie", "authorization", "proxy-authorization", "on-demand-session-token", "forwarded", "x-real-ip", "true-client-ip",
  "cf-connecting-ip", "x-lab-door", "host", "expect", "referer",
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authenticate",
]);
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization"]);

/** Whether a header name is one the relay never sends on. */
export function neverSent(name: string): boolean {
  const n = name.toLowerCase();
  return NEVER.has(n) || n.startsWith("sec-fetch-") || n.startsWith("x-forwarded-") || n.startsWith("tailscale-user-");
}

/** The headers that go upstream: everything the client sent but what is never sent, and any header the Connection header names;
    `Host` is the app's name. For an upgrade the caller adds `connection: upgrade` and `upgrade: websocket` back itself. */
export function upstreamHeaders(incoming: Headers, name: string): Record<string, string | string[]> {
  const named = new Set(one(incoming["connection"]).toLowerCase().split(",").map((s) => s.trim()).filter((s) => s !== ""));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined || neverSent(key) || named.has(key)) continue;
    out[key] = v;
  }
  out["host"] = name;
  return out;
}

/** On-Demand's own token carriers in an address: its session token's parameter and RFC 6750's `access_token`, which its identity
    step reads as an explicit credential and would use in place of the person's identity. They are cut from the query. */
const TOKEN_PARAMS = new Set(["ondemand_session_token", "access_token"]);

export function cleanPath(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);   // a fragment is never in a request target, but be exact
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash);
  const kept = query.split("&").filter((pair) => {
    const key = pair.split("=", 1)[0] ?? "";
    let decoded = key;
    try { decoded = decodeURIComponent(key.replace(/\+/g, " ")); } catch { /* an odd escape: compared as written */ }
    return !TOKEN_PARAMS.has(decoded.toLowerCase());
  });
  return url.slice(0, q) + (kept.length > 0 && kept.join("") !== "" ? `?${kept.join("&")}` : "");
}

/** Response headers that go back to the page: hop-by-hop ones are dropped, and so is Set-Cookie, since cookies of every
    localhost port are one jar and the relay sends none upstream, so a cookie the workspace sets could only be planted on the
    person's other local sites. A redirect to the app's own name is turned back to the forward's address. */
export function responseHeaders(raw: Headers, name: string, host: string): Record<string, string | string[]> {
  const named = new Set(one(raw["connection"]).toLowerCase().split(",").map((s) => s.trim()).filter((s) => s !== ""));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP.has(key) || named.has(key) || key === "set-cookie" || key === "set-cookie2") continue;
    out[key] = v;
  }
  const loc = out["location"];
  if (typeof loc === "string") out["location"] = rewriteLocation(loc, name, host);
  return out;
}

/** `https://<app name>/x` becomes `http://<the Host the client used>/x`; any other address is left as it is. */
export function rewriteLocation(location: string, name: string, host: string): string {
  const prefix = `https://${name}`;
  const lower = location.toLowerCase();
  if (lower === prefix || lower.startsWith(prefix + "/") || lower.startsWith(prefix + "?")) return `http://${host}${location.slice(prefix.length)}`;
  return location;
}

/** The self-test's stand-in for On-Demand: a loopback http address only, unpackaged, `--selftest` (config.ts). */
export interface Upstream {
  /** The address dialled, given the app's name. */
  target(name: string): { host: string; port: number; secure: boolean };
}

/** On-Demand itself: the app's name, on 443, over TLS whose certificate is verified as for any site. */
export const ONDEMAND: Upstream = { target: (name) => ({ host: name, port: 443, secure: true }) };

/** The self-test's: every name goes to one loopback address over plain http. Only a loopback address is accepted. */
export function loopbackUpstream(origin: string): Upstream | null {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(origin);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { target: () => ({ host: "127.0.0.1", port, secure: false }) } : null;
}
