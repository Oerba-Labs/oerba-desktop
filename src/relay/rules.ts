/* The localhost relay's rules, as pure functions: which requests a forward answers, what name it dials, and which headers go on.
   Nothing here touches a socket. The reasons are in SECURITY.md ("The localhost relay").

   The guard is against web pages. Any program on the Mac already reaches On-Demand's names as the person (the tailnet address
   is theirs), so the relay adds nothing for programs; what it must not do is let a page in the person's browser read from or
   write through a forward: DNS rebinding (a Host that is not ours), a cross-origin fetch (an Origin that is not ours, or
   Fetch Metadata saying cross-site) and a forged request are each refused before anything is dialled. */

export const UPSTREAM_SUFFIX = ".ondemand.oerba.dev";

/** A DNS label made of a name On-Demand accepts (its own nameRegex: letters and digits, single hyphens inside). */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/;

const NAME_RAW = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\s\S])/;

/** The agent's name in a port's address. On-Demand refuses a port-shaped name without one ("agent name is required for port-based
    URLs", ondemandd/workspaceapps/appurl/appurl.go ParseSubdomainAppURL), and /api/now does not say it. Both of the lab's templates
    name their agent `main` (~/Workspaces/devserver/coder/templates/project/main.tf:289 and sandbox/main.tf:211), so a workspace
    whose template names it otherwise is not reached. */
export const AGENT = "main";

/** The name a forward dials, or null. Only a plain port number (four or five digits: On-Demand's own PortRegex, and it
    reserves the ports below 1024), a workspace and an owner of the strict shape, joined as On-Demand names a port's door:
    `<port>--<agent>--<workspace>--<owner>.ondemand.oerba.dev`. A name with "--" inside, a dot, an underscore, an @ or anything else is
    refused, so no input can make the name end elsewhere or add a label. */
export function upstreamName(port: unknown, workspace: unknown, owner: unknown): string | null {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (typeof workspace !== "string" || typeof owner !== "string") return null;
  // The shape is asked of the raw strings, ASCII only, before any case change: toLowerCase() turns U+212A (the Kelvin sign) into "k".
  // On-Demand's own pattern allows capitals (appurl.go nameRegex) and a host name is not case-sensitive, so capitals are kept as valid and lowered after.
  if (!NAME_RAW.test(workspace) || !NAME_RAW.test(owner)) return null;
  const w = workspace.toLowerCase(), o = owner.toLowerCase();
  if (!NAME.test(w) || !NAME.test(o)) return null;
  const label = `${port}--${AGENT}--${w}--${o}`;
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
export function originAllowed(origin: string | string[] | undefined, port: number, forwarded: (n: number) => boolean = (n) => n === port): boolean {
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  const m = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?![\s\S])/.exec(origin.toLowerCase());
  if (!m) return false;
  const n = Number(m[1]);
  // the forward's own page, or the page of another forward this app is running (a frontend on 5173 calling an API on 8000)
  return String(n) === m[1] && (n === port || forwarded(n));
}

/** Fetch Metadata, mirroring On-Demand's own rule (`identityAllowedFor`, ondemandd/httpmw/trustedidentity.go): none, same-origin and
    none-site pass; any other (cross-site, same-site, a value not known) only as a top-level GET or HEAD navigation to a document. */
export function fetchSite(headers: Headers, method: string, siblingOrigin = false): "pass" | "navigation" | "refuse" {
  const site = one(headers["sec-fetch-site"]);
  // No Fetch Metadata at all (Metro, the Simulator, curl, a browser older than Chrome 76, Firefox 90 or Safari 16.4) passes: nothing tells it from a program.
  if (site === "" || site === "same-origin" || site === "none") return "pass";
  // same-site from a sibling forward of the same workspace: only with an Origin that said so (the caller checked it), since the header alone does not say which port
  if (site === "same-site" && siblingOrigin) return "pass";
  return one(headers["sec-fetch-mode"]) === "navigate" && one(headers["sec-fetch-dest"]) === "document" && (method === "GET" || method === "HEAD") ? "navigation" : "refuse";
}

/** Whether a request is not refused outright (a cross-site navigation is not, though the relay answers it with its own page). */
export const fetchSiteAllowed = (headers: Headers, method: string, siblingOrigin = false): boolean => fetchSite(headers, method, siblingOrigin) !== "refuse";

export type Verdict = { ok: true } | { ok: false; status: number; why: string };

/** The three checks, in order, for a request or an upgrade. */
export function vet(headers: Headers, method: string, url: string | undefined, port: number, forwarded: (n: number) => boolean = (n) => n === port): Verdict {
  if (!hostAllowed(headers["host"], port)) return { ok: false, status: 421, why: "host" };
  if (!originAllowed(headers["origin"], port, forwarded)) return { ok: false, status: 403, why: "origin" };
  const site = fetchSite(headers, method, headers["origin"] !== undefined);
  if (site === "refuse") return { ok: false, status: 403, why: "fetch-site" };
  // Origin-form only: "/path?query". An absolute address, "*" or an authority would make the relay name somewhere itself.
  // A backslash is read as a slash by Chrome and Safari ("/\\evil.example" is "//evil.example"), so none is accepted, raw or as %5C.
  if (typeof url !== "string" || url.includes("\\") || /%5c/i.test(url) || !url.startsWith("/") || url.startsWith("//") || /[\u0000- \u007f]/.test(url)) return { ok: false, status: 400, why: "target" };
  // A top-level navigation from another site is answered by the relay's own page, never forwarded: a dev server often changes state on a GET.
  if (site === "navigation") return { ok: false, status: 200, why: "navigation" };
  return { ok: true };
}

/** Headers that are never sent upstream: the browser's (Origin, Fetch Metadata, Cookie of every other localhost site), every
    credential (the relay holds none and a dev app's must not reach On-Demand's: its identity step and token reader read an
    Authorization: Bearer as an explicit session token, ondemandd/httpmw/trustedidentity.go hasExplicitToken and
    httpmw/apikey.go bearerToken, so it would be refused), On-Demand's session-token header, every Forwarded / X-Forwarded-* a
    client sent, the identity header's family, and the hop-by-hop headers. */
const NEVER = new Set([
  "origin", "authorization", "proxy-authorization", "on-demand-session-token", "forwarded", "x-real-ip", "true-client-ip",
  "cf-connecting-ip", "x-lab-door", "host", "expect", "referer",
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authenticate",
]);
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization"]);

/** On-Demand's own cookies, by name, as `StripOnDemandCookies` drops them (ondemandd/httpapi/cookie.go:23-32; names in
    ondemandsdk/client.go: 35, 41, 47, 57, 65 (a prefix: one per workspace proxy) and 69). They never go to a workspace's app and
    none is ever set on localhost. */
export function onDemandCookie(name: string): boolean {
  return name === "ondemand_session_token" || name === "oauth_state" || name === "oauth_redirect" || name === "ondemand_path_app_session_token" ||
    name === "ondemand_signed_app_token" || name.startsWith("ondemand_subdomain_app_session_token");
}

/** A Cookie header cut to the names this workspace's forwards have set themselves, and without On-Demand's own; null when nothing is
    left. So the session cookie of another program on another localhost port never reaches a workspace. */
export function cookieUpstream(header: string, names: ReadonlySet<string>): string | null {
  const kept = header.split(";").map((p) => p.trim()).filter((p) => { const n = p.split("=", 1)[0] ?? ""; return p !== "" && names.has(n) && !onDemandCookie(n); });
  return kept.length > 0 ? kept.join("; ") : null;
}

/** A Set-Cookie line for localhost: the Domain attribute removed so it lands on the host the page used; null for one of On-Demand's. */
export function setCookieDown(line: string): string | null {
  const parts = line.split(";");
  if (onDemandCookie((parts[0] ?? "").split("=", 1)[0]!.trim())) return null;
  return parts.filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p)).join(";");
}

/** Whether a Set-Cookie line deletes its cookie: a Max-Age of 0 or less, or an Expires in the past. Such a line names a cookie without setting it. */
export function cookieDeletes(line: string, now = Date.now()): boolean {
  for (const attr of line.split(";").slice(1)) {
    const [k, ...rest] = attr.split("=");
    const key = (k ?? "").trim().toLowerCase(), val = rest.join("=").trim();
    if (key === "max-age" && /^-?[0-9]+$/.test(val) && Number(val) <= 0) return true;
    if (key === "expires") { const t = Date.parse(val); if (!Number.isNaN(t) && t < now) return true; }
  }
  return false;
}

/** Whether a header name is one the relay never sends on. */
export function neverSent(name: string): boolean {
  const n = name.toLowerCase();
  return NEVER.has(n) || n.startsWith("sec-fetch-") || n.startsWith("x-forwarded-") || n.startsWith("tailscale-user-");
}

/** The headers that go upstream: everything the client sent but what is never sent, and any header the Connection header names;
    `Host` is the app's name. For an upgrade the caller adds `connection: upgrade` and `upgrade: websocket` back itself. */
export function upstreamHeaders(incoming: Headers, name: string, cookieNames: ReadonlySet<string> = new Set()): Record<string, string | string[]> {
  const named = new Set(one(incoming["connection"]).toLowerCase().split(",").map((s) => s.trim()).filter((s) => s !== ""));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined || neverSent(key) || named.has(key)) continue;
    if (key === "cookie") { const c = cookieUpstream(one(v), cookieNames); if (c !== null) out[key] = c; continue; }
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

/** Response headers that go back to the page: hop-by-hop ones are dropped; Set-Cookie passes with its Domain
    removed (so it lands on localhost), except On-Demand's own. A redirect to the app's own name is turned back to the forward's address. */
export function responseHeaders(raw: Headers, name: string, host: string, onCookie: (name: string) => void = () => undefined): Record<string, string | string[]> {
  const named = new Set(one(raw["connection"]).toLowerCase().split(",").map((s) => s.trim()).filter((s) => s !== ""));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP.has(key) || named.has(key) || key === "set-cookie2") continue;
    if (key === "set-cookie") { const c = (Array.isArray(v) ? v : [v]).map(setCookieDown).filter((x): x is string => x !== null); for (const line of c) if (!cookieDeletes(line)) onCookie((line.split(";", 1)[0] ?? "").split("=", 1)[0]!.trim()); if (c.length > 0) out[key] = c; continue; }
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

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The page a cross-site top-level navigation is answered with, in place of forwarding it. The link is a same-origin one to the same
    path and query, so clicking it is a same-origin navigation, which passes. Nothing in it comes from upstream. */
export function interstitial(port: number, host: string, pathAndQuery: string): string {
  const shown = `localhost:${port}${pathAndQuery}`;
  // Absolute, from the Host vet accepted (localhost, 127.0.0.1 or [::1] with this port) and a path that starts with one "/", so it cannot name another origin.
  const href = `http://${host}${pathAndQuery}`;
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Oerba</title>
<p>Opened from another site.</p>
<p><a href="${esc(href)}" rel="noreferrer">Continue to ${esc(shown)}</a></p>
`;
}
