import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { createHash } from "node:crypto";
import { AGENT, cleanPath, cookieUpstream, setCookieDown, fetchSiteAllowed, hostAllowed, loopbackUpstream, neverSent, ONDEMAND, originAllowed, responseHeaders, rewriteLocation, upstreamHeaders, upstreamName, vet } from "../src/relay/rules";
import { COMMON_PORTS, RelayManager } from "../src/relay/manager";
import { buildMenu, labelsOf } from "../src/present/menu";

// ---- the rules, pure --------------------------------------------------------------------------------------------------------

test("the upstream name is built from a plain port, workspace and owner and ends under ondemand.oerba.dev", () => {
  assert.equal(upstreamName(8081, "demo", "alice"), "8081--main--demo--alice.ondemand.oerba.dev");
  assert.equal(upstreamName(19006, "My-App", "Alice"), "19006--main--my-app--alice.ondemand.oerba.dev");
  for (const port of [80, 1023, 65536, 8081.5, -1, NaN, "8081", null, undefined]) assert.equal(upstreamName(port, "demo", "alice"), null, String(port));
  for (const bad of ["a.b", "a_b", "a--b", "-a", "a-", "a/b", "a b", "a@github", "a\nb", "", "x.evil.com#", "a:1", "é", "a\u0000", 5, null]) {
    assert.equal(upstreamName(8081, bad, "alice"), null, JSON.stringify(bad));
    assert.equal(upstreamName(8081, "demo", bad), null, JSON.stringify(bad));
  }
  assert.equal(upstreamName(8081, "x".repeat(60), "alice"), null, "a DNS label is at most 63");
  for (const [w, o] of [["demo", "alice"], ["a-b-c", "d-e"], ["9", "9"]] as const) assert.ok(upstreamName(8081, w, o)!.endsWith(".ondemand.oerba.dev"));
});

/** The fork's own parser, ondemandd/workspaceapps/appurl/appurl.go (appURL, PortRegex, ParseSubdomainAppURL), as the same regular expressions. */
const NAME_RX = "[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*";
const FORK = new RegExp(`^(${NAME_RX})(?:--(${NAME_RX}))?--(${NAME_RX})--(${NAME_RX})$`);
const FORK_PORT = /^\d{4,5}s?$/;
function forkParse(sub: string): { slug: string; agent: string; workspace: string; owner: string } | null {
  const m = FORK.exec(sub.split("---").at(-1)!);
  if (!m) return null;
  const [, slug, agent = "", workspace, owner] = m;
  if (FORK_PORT.test(slug!) && agent === "") return null;   // "agent name is required for port-based URLs"
  return { slug: slug!, agent: FORK_PORT.test(slug!) ? agent : "", workspace: workspace!, owner: owner! };
}

test("the built name parses under the fork's rule: port, then agent, then workspace, then owner", () => {
  const name = upstreamName(8081, "demo", "alice")!;
  assert.deepEqual(forkParse(name.slice(0, -".ondemand.oerba.dev".length)), { slug: "8081", agent: AGENT, workspace: "demo", owner: "alice" });
  assert.equal(AGENT, "main");
  assert.equal(forkParse("8081--demo--alice"), null, "the old shape, with no agent, is refused by the fork");
  for (const [w, o] of [["my-app", "bob-2"], ["a", "b"]] as const) assert.ok(forkParse(upstreamName(19006, w, o)!.split(".")[0]!));
});

test("Host must be this forward's own", () => {
  for (const h of ["localhost:8081", "LOCALHOST:8081", "127.0.0.1:8081", "[::1]:8081"]) assert.equal(hostAllowed(h, 8081), true, h);
  for (const h of ["localhost", "localhost:8082", "evil.example:8081", "localhost.evil.example:8081", "127.0.0.1:8081.evil", "evil.example", "", undefined, "localhost:8081, evil", "0.0.0.0:8081", "[::1]", "user@localhost:8081"]) assert.equal(hostAllowed(h, 8081), false, String(h));
  assert.equal(hostAllowed(["localhost:8081", "localhost:8081"], 8081), false);
});

test("Origin, when present, must be the forward's own page", () => {
  assert.equal(originAllowed(undefined, 8081), true);
  for (const o of ["http://localhost:8081", "http://127.0.0.1:8081", "http://[::1]:8081"]) assert.equal(originAllowed(o, 8081), true, o);
  for (const o of ["https://localhost:8081", "http://localhost:3000", "http://localhost", "null", "", "http://evil.example", "https://app.oerba.dev", "http://localhost:8081.evil.example", "http://localhost:8081/"]) assert.equal(originAllowed(o, 8081), false, o);
});

test("another forward of the app is an allowed origin; any other localhost port is not", () => {
  const mine = (n: number) => n === 8081 || n === 5173;
  for (const o of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "http://localhost:8081"]) assert.equal(originAllowed(o, 8081, mine), true, o);
  for (const o of ["http://localhost:3000", "http://localhost:05173", "https://localhost:5173", "http://localhost:5173.evil.example", "http://evil.example:5173", "http://localhost"]) assert.equal(originAllowed(o, 8081, mine), false, o);
  const ok = { host: "localhost:8081", origin: "http://localhost:5173", "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
  assert.deepEqual(vet(ok, "GET", "/api", 8081, mine), { ok: true });
  assert.equal(vet(ok, "GET", "/api", 8081).ok, false, "not a forward: refused");
  assert.equal(vet({ ...ok, origin: "http://localhost:3000" }, "GET", "/api", 8081, mine).ok, false);
  assert.equal(vet({ host: "localhost:8081", "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }, "GET", "/", 8081, mine).ok, false, "same-site with no Origin says nothing of which port");
  assert.equal(vet({ ...ok, "sec-fetch-site": "cross-site" }, "GET", "/api", 8081, mine).ok, false);
});

test("cookies: the app's own go both ways, On-Demand's own never, and a Domain is removed", () => {
  assert.equal(cookieUpstream("sid=1; ondemand_session_token=T; oauth_state=x; ondemand_subdomain_app_session_token_abc=y; theme=dark; ondemand_path_app_session_token=p; oauth_redirect=r; ondemand_signed_app_token=s; admin=local", new Set(["sid", "theme", "oauth_state", "ondemand_session_token"])), "sid=1; theme=dark");
  assert.equal(cookieUpstream("ondemand_session_token=T", new Set(["ondemand_session_token"])), null);
  assert.equal(setCookieDown("sid=1; Path=/; Domain=8081--main--demo--alice.ondemand.oerba.dev; HttpOnly"), "sid=1; Path=/; HttpOnly");
  assert.equal(setCookieDown("sid=1; DOMAIN = x.example; Secure"), "sid=1; Secure");
  for (const n of ["ondemand_session_token", "oauth_state", "ondemand_subdomain_app_session_token_h"]) assert.equal(setCookieDown(`${n}=v; Path=/`), null, n);
  const up = upstreamHeaders({ cookie: "sid=1; ondemand_session_token=T; admin=x" }, "n", new Set(["sid"]));
  assert.equal(up["cookie"], "sid=1");
  assert.equal(upstreamHeaders({ cookie: "ondemand_session_token=T" }, "n", new Set(["ondemand_session_token"]))["cookie"], undefined);
  assert.equal(upstreamHeaders({ cookie: "sid=1" }, "n")["cookie"], undefined, "no names known: none sent");
  assert.deepEqual(responseHeaders({ "set-cookie": ["a=1; Domain=x.example", "ondemand_session_token=z"] }, "n", "localhost:8081"), { "set-cookie": ["a=1"] });
});

test("Fetch Metadata: cross-site and same-site only as a top-level navigation, as On-Demand's own rule", () => {
  assert.equal(fetchSiteAllowed({}, "GET"), true);
  assert.equal(fetchSiteAllowed({ "sec-fetch-site": "same-origin" }, "POST"), true);
  assert.equal(fetchSiteAllowed({ "sec-fetch-site": "none" }, "GET"), true);
  for (const site of ["cross-site", "same-site", "weird"]) {
    assert.equal(fetchSiteAllowed({ "sec-fetch-site": site }, "GET"), false, site);
    assert.equal(fetchSiteAllowed({ "sec-fetch-site": site, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }, "GET"), false);
    assert.equal(fetchSiteAllowed({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, "GET"), true, site);
    assert.equal(fetchSiteAllowed({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, "HEAD"), true);
    assert.equal(fetchSiteAllowed({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, "POST"), false);
    assert.equal(fetchSiteAllowed({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, "GET"), false);
  }
});

test("a request target must be origin-form", () => {
  const ok = { host: "localhost:8081" };
  assert.deepEqual(vet(ok, "GET", "/index.bundle?platform=ios", 8081), { ok: true });
  for (const url of ["http://evil.example/", "*", "//evil.example/x", "evil", "/a b", "/a\r\nx", undefined]) assert.equal(vet(ok, "GET", url, 8081).ok, false, String(url));
  assert.deepEqual(vet({ host: "evil:8081" }, "GET", "/", 8081), { ok: false, status: 421, why: "host" });
  assert.deepEqual(vet({ host: "localhost:8081", origin: "http://evil" }, "GET", "/", 8081), { ok: false, status: 403, why: "origin" });
});

test("what is never sent upstream, and the token parameters cut from the address", () => {
  const sent = upstreamHeaders({
    host: "localhost:8081", origin: "http://localhost:8081", cookie: "a=b", authorization: "Bearer t", "proxy-authorization": "x", "on-demand-session-token": "t",
    "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-user": "?1", forwarded: "for=1.2.3.4", "x-forwarded-for": "6.6.6.6", "x-forwarded-host": "evil", "x-forwarded-proto": "https",
    "tailscale-user-login": "boss@github", "x-real-ip": "1.1.1.1", connection: "keep-alive, x-private", "x-private": "1", "keep-alive": "5", upgrade: "h2c", "transfer-encoding": "chunked", te: "trailers", expect: "100-continue",
    accept: "text/html", "user-agent": "ua", "x-app": "kept", "content-type": "application/json",
  }, "8081--main--demo--alice.ondemand.oerba.dev");
  assert.deepEqual(Object.keys(sent).sort(), ["accept", "content-type", "host", "user-agent", "x-app"]);
  assert.equal(sent["host"], "8081--main--demo--alice.ondemand.oerba.dev");
  for (const n of ["Origin", "Authorization", "Sec-Fetch-Mode", "X-Forwarded-Host", "Forwarded", "On-Demand-Session-Token", "Tailscale-User-Login", "Transfer-Encoding"]) assert.equal(neverSent(n), true, n);
  assert.equal(cleanPath("/a?x=1&access_token=s&ondemand_session_token=t&y=2"), "/a?x=1&y=2");
  assert.equal(cleanPath("/a?ACCESS_TOKEN=s"), "/a");
  assert.equal(cleanPath("/a?%61ccess_token=s&k=v"), "/a?k=v");
  assert.equal(cleanPath("/a?q=access_token"), "/a?q=access_token");
  assert.equal(cleanPath("/index.bundle"), "/index.bundle");
});

test("a response comes back without hop-by-hop headers, and a redirect to the app's name comes home", () => {
  const name = "8081--main--demo--alice.ondemand.oerba.dev";
  const out = responseHeaders({ "content-type": "text/html", "set-cookie": ["a=b"], connection: "close", "keep-alive": "1", location: `https://${name}/next?x=1`, "transfer-encoding": "chunked" }, name, "localhost:8081");
  assert.deepEqual(out, { "content-type": "text/html", "set-cookie": ["a=b"], location: "http://localhost:8081/next?x=1" });
  assert.equal(rewriteLocation("https://other.example/x", name, "localhost:8081"), "https://other.example/x");
  assert.equal(rewriteLocation(`https://${name}.evil.example/`, name, "localhost:8081"), `https://${name}.evil.example/`);
  assert.equal(rewriteLocation("/relative", name, "localhost:8081"), "/relative");
});

test("only a loopback http address can stand in for On-Demand; the real one is TLS to the name on 443", () => {
  assert.equal(loopbackUpstream("http://127.0.0.1:9000")!.target("x").secure, false);
  for (const bad of ["https://127.0.0.1:9000", "http://10.0.0.1:9000", "http://evil.example:80", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://127.0.0.1:9000/x"]) assert.equal(loopbackUpstream(bad), null, bad);
  assert.deepEqual(ONDEMAND.target("8081--main--d--a.ondemand.oerba.dev"), { host: "8081--main--d--a.ondemand.oerba.dev", port: 443, secure: true });
});

// ---- the relay, against a stand-in for On-Demand on loopback -----------------------------------------------------------------

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const seen: Seen[] = [];
let upgrades = 0;
const stand = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url?.startsWith("/slow")) {   // streamed: the first chunk is out long before the end
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first;");
      setTimeout(() => res.end("last"), 700);
      return;
    }
    if (req.url?.startsWith("/redirect")) { res.writeHead(302, { location: `https://${req.headers.host}/landed`, "set-cookie": "s=1" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", "set-cookie": ["session=1; Path=/; Domain=x.ondemand.oerba.dev", "ondemand_session_token=LEAK; Path=/"] });
    res.end(JSON.stringify({ ok: true }));
  });
});
stand.on("upgrade", (req, socket) => {   // a websocket echo: the handshake, then every byte back
  upgrades++;
  seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.pipe(socket);
});
let upstream: NonNullable<ReturnType<typeof loopbackUpstream>>;
let relay: RelayManager;
before(async () => {
  const standPort = await new Promise<number>((r) => stand.listen(0, "127.0.0.1", () => r((stand.address() as net.AddressInfo).port)));
  upstream = loopbackUpstream(`http://127.0.0.1:${standPort}`)!;
  relay = new RelayManager(upstream);
});
after(async () => { await relay.stopAll(); stand.closeAllConnections(); stand.close(); });

const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const dev = async (name = "demo", owner = "alice") => { const p = await freePort(); const f = await relay.start(owner, name, Math.max(p, 1024)); assert.ok(f); return f; };

function request(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.host !== undefined) headers["host"] = opts.host;
    const r = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers, setHost: opts.host === undefined, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    r.end(opts.body);
  });
}

/** A raw websocket handshake: the answer's head, and the socket for the bytes after it. */
function handshake(port: number, extra: Record<string, string> = {}, host = `127.0.0.1:${port}`): Promise<{ head: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const headers = { host, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", ...extra };
    socket.write(`GET /hmr HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    let buf = "";
    socket.on("data", (c) => { buf += c.toString("latin1"); const i = buf.indexOf("\r\n\r\n"); if (i >= 0) { socket.removeAllListeners("data"); resolve({ head: buf.slice(0, i), socket }); } });
    socket.on("error", reject);
    socket.on("close", () => { if (!buf.includes("\r\n\r\n")) resolve({ head: buf, socket }); });
  });
}

test("a GET and a POST body pass through, by the workspace port's own name", async () => {
  const f = await dev();
  const before = seen.length;
  const get = await request(f.local, { path: "/index.bundle?platform=ios", headers: { accept: "*/*" } });
  assert.equal(get.status, 200);
  assert.deepEqual(JSON.parse(get.body), { ok: true });
  const post = await request(f.local, { method: "POST", path: "/symbolicate", headers: { "content-type": "application/json" }, body: '{"stack":[1,2,3]}' });
  assert.equal(post.status, 200);
  const [a, b] = seen.slice(before);
  assert.equal(a!.url, "/index.bundle?platform=ios");
  assert.equal(a!.headers.host, `${f.remote}--main--demo--alice.ondemand.oerba.dev`);
  assert.equal(b!.method, "POST");
  assert.equal(b!.body, '{"stack":[1,2,3]}');
  assert.deepEqual(get.headers["set-cookie"], ["session=1; Path=/"], "the app's cookie lands on localhost, its Domain removed");
});

test("a websocket passes both ways", async () => {
  const f = await dev();
  const { head, socket } = await handshake(f.local);
  assert.match(head, /^HTTP\/1\.1 101 /);
  assert.match(head, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
  const echoed = await new Promise<string>((resolve) => { socket.once("data", (c) => resolve(c.toString())); socket.write("hello through the relay"); });
  assert.equal(echoed, "hello through the relay");
  socket.destroy();
  const last = seen.at(-1)!;
  assert.equal(last.headers.host, `${f.remote}--main--demo--alice.ondemand.oerba.dev`);
  assert.equal(last.headers.origin, undefined);
});

test("a response is streamed, not held", async () => {
  const f = await dev();
  const t0 = Date.now();
  const firstAt = await new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: f.local, path: "/slow", agent: false }, (res) => { res.once("data", () => resolve(Date.now() - t0)); res.resume(); }).on("error", reject);
  });
  assert.ok(firstAt < 500, `the first chunk came after ${firstAt} ms`);
});

test("a wrong Host, a wrong Origin and a cross-site non-navigation are each refused, and reach nothing", async () => {
  const f = await dev();
  const before = seen.length;
  assert.equal((await request(f.local, { host: `evil.example:${f.local}` })).status, 421);
  assert.equal((await request(f.local, { host: "localhost:1" })).status, 421);
  assert.equal((await request(f.local, { headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await request(f.local, { headers: { origin: `http://localhost:${f.local + 1}` } })).status, 403);
  assert.equal((await request(f.local, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403);
  assert.equal((await request(f.local, { method: "POST", headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, body: "x" })).status, 403);
  assert.equal(seen.length, before, "no refused request reached the stand-in");
  // a top-level navigation by a link from another site is the one cross-site thing allowed, as On-Demand allows it
  assert.equal((await request(f.local, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).status, 200);
  // the dev server's own page may ask
  assert.equal((await request(f.local, { headers: { origin: `http://localhost:${f.local}`, "sec-fetch-site": "same-origin" } })).status, 200);
});

test("a websocket with a wrong Host or Origin, or from another site, is refused before anything is dialled", async () => {
  const f = await dev();
  const before = upgrades;
  for (const [extra, host] of [[{}, `evil.example:${f.local}`], [{ origin: "http://evil.example" }, undefined], [{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" }, undefined]] as const) {
    const { head, socket } = await handshake(f.local, { ...extra }, host);
    assert.match(head, /^HTTP\/1\.1 4\d\d /);
    socket.destroy();
  }
  assert.equal(upgrades, before);
});

test("no browser header, credential, forwarded header or token reaches the stand-in", async () => {
  const f = await dev();
  await request(f.local);   // the workspace sets its "session" cookie, so that name is the workspace's own
  const before = seen.length;
  await request(f.local, {
    path: "/x?keep=1&access_token=SECRET&ondemand_session_token=SECRET2",
    headers: {
      origin: `http://localhost:${f.local}`, cookie: "session=abc; admin=local-tool; ondemand_session_token=zzz", authorization: "Bearer SECRET", "proxy-authorization": "Basic x", "on-demand-session-token": "SECRET3",
      "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-user": "?1", forwarded: "for=6.6.6.6", "x-forwarded-for": "6.6.6.6", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https",
      "tailscale-user-login": "someone@github", connection: "keep-alive", "x-keep": "yes",
    },
  });
  const got = seen.at(-1)!;
  assert.equal(got.url, "/x?keep=1");
  assert.equal(got.headers["cookie"], "session=abc", "another program's cookie on localhost is not sent, nor On-Demand's");
  for (const h of ["origin", "authorization", "proxy-authorization", "on-demand-session-token", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "tailscale-user-login"]) assert.equal(got.headers[h], undefined, h);
  assert.equal(got.headers["x-keep"], "yes");
  assert.ok(!JSON.stringify(got).includes("SECRET"));
  // and the same for an upgrade
  const { socket } = await handshake(f.local, { origin: `http://localhost:${f.local}`, cookie: "a=b", authorization: "Bearer SECRET", "x-forwarded-host": "evil", "sec-websocket-protocol": "expo" });
  socket.destroy();
  const up = seen.at(-1)!;
  for (const h of ["origin", "authorization", "x-forwarded-host"]) assert.equal(up.headers[h], undefined, `ws ${h}`);
  assert.equal(up.headers["sec-websocket-protocol"], "expo");
});

test("a page of one forward may call another forward of the same workspace, and no other forward or localhost port", async () => {
  const api = await dev("app");
  const web = await dev("app");
  const stranger = await dev("other-ws");
  const before = seen.length;
  const call = (to: number, origin: string, site = "same-site") => request(to, { headers: { origin, "sec-fetch-site": site, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } });
  assert.equal((await call(api.local, `http://localhost:${web.local}`)).status, 200, "A to A");
  assert.equal((await call(api.local, `http://127.0.0.1:${web.local}`)).status, 200);
  assert.equal((await call(stranger.local, `http://localhost:${web.local}`)).status, 403, "A to B: another workspace's forward");
  assert.equal((await call(api.local, `http://localhost:${stranger.local}`)).status, 403, "B to A");
  assert.equal((await call(api.local, `http://localhost:${await freePort()}`)).status, 403, "a localhost port the app is not forwarding");
  assert.equal(seen.length, before + 2);
  await relay.stop(web.id);
  assert.equal((await call(api.local, `http://localhost:${web.local}`)).status, 403, "once that forward stops, its page is a stranger");
});

test("a cross-site navigation is answered by the relay's own page, forwarded nowhere, and its link is the escaped same path", async () => {
  const f = await dev();
  const before = seen.length;
  const nav = (site: string, path: string) => request(f.local, { path, headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  for (const site of ["cross-site", "same-site"]) {
    const r = await nav(site, `/logout?next=%22><script>alert(1)</script>&a='b'`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["set-cookie"], undefined);
    assert.ok(r.body.includes("Opened from another site."));
    assert.ok(r.body.includes(`href="/logout?next=%22&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;a=&#39;b&#39;"`), r.body);
    assert.ok(!r.body.includes("<script>"));
    assert.ok(r.body.includes(`Continue to localhost:${f.local}/logout`));
  }
  assert.equal(seen.length, before, "nothing reached the stand-in");
  // Continue is a same-origin navigation; one typed in the bar or from a bookmark is "none"; both go straight through
  assert.equal((await nav("same-origin", "/logout")).status, 200);
  assert.equal(seen.length, before + 1);
  assert.equal((await nav("none", "/x")).body, '{"ok":true}');
  assert.equal(seen.length, before + 2);
  // a POST, or a navigation to a frame, is refused rather than answered with the page
  assert.equal((await request(f.local, { method: "POST", body: "x", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).status, 403);
  assert.equal((await request(f.local, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } })).status, 403);
  assert.equal(seen.length, before + 2);
  // Metro, the Simulator and curl send neither Origin nor Sec-Fetch-Site
  assert.equal((await request(f.local, { headers: { "user-agent": "Expo/1 CFNetwork" } })).status, 200);
});

test("a workspace's name is checked in ASCII before any case change: the Kelvin sign is not a k", () => {
  assert.equal(upstreamName(8081, "\u212Aelvin", "alice"), null);
  assert.equal(upstreamName(8081, "demo", "\u212A"), null);
  assert.equal(upstreamName(8081, "Demo", "Alice"), "8081--main--demo--alice.ondemand.oerba.dev", "capitals are On-Demand's own pattern and are lowered");
  assert.equal(upstreamName(8081, "\u0130stanbul", "alice"), null);
});

test("limits: 256 connections a forward, 503 past the in-flight bound, 502 when upstream will not connect in time", async () => {
  const f = await dev();
  assert.equal(relay.connectionLimit(f.id), 256);
  // in-flight: a bound of 2, three slow requests at once
  const small = new RelayManager(upstream, () => undefined, { maxInFlight: 2 });
  const s = (await small.start("alice", "busy", Math.max(await freePort(), 1024)))!;
  const slow = [0, 1].map(() => request(s.local, { path: "/slow" }));
  await new Promise((r) => setTimeout(r, 150));
  const third = await request(s.local, { path: "/slow" });
  assert.equal(third.status, 503);
  await Promise.all(slow);
  assert.equal((await request(s.local)).status, 200, "and the bound frees as requests end");
  await small.stopAll();
  // connect timeout: a TLS upstream that accepts the connection and never answers the handshake
  const mute = net.createServer((sock) => { sock.on("error", () => undefined); });
  const mutePort = await new Promise<number>((r) => mute.listen(0, "127.0.0.1", () => r((mute.address() as net.AddressInfo).port)));
  const tlsStand = { target: () => ({ host: "127.0.0.1", port: mutePort, secure: true }) };
  const slowStart = new RelayManager(tlsStand, () => undefined, { connectMs: 300 });
  const t = (await slowStart.start("alice", "mute", Math.max(await freePort(), 1024)))!;
  const t0 = Date.now();
  const r = await request(t.local);
  assert.equal(r.status, 502);
  assert.ok(Date.now() - t0 < 3000);
  const ws = await handshake(t.local);
  assert.match(ws.head, /^HTTP\/1\.1 502 /);
  ws.socket.destroy();
  await slowStart.stopAll();
  mute.close();
});

test("a workspace's cookie names are remembered per workspace, in memory, and forgotten when the app quits", async () => {
  const m = new RelayManager(upstream);
  const a = (await m.start("alice", "jar", Math.max(await freePort(), 1024)))!;
  const send = () => request(a.local, { headers: { cookie: "session=1; admin=local" } }).then(() => seen.at(-1)!.headers.cookie);
  assert.equal(await send(), undefined, "before the workspace has set any cookie, none is sent");
  await request(a.local);   // the stand-in sets "session"
  assert.equal(await send(), "session=1");
  const b = (await m.start("alice", "jar", Math.max(await freePort(), 1024)))!;   // another forward of the same workspace shares the names
  assert.equal(await request(b.local, { headers: { cookie: "session=2; admin=x" } }).then(() => seen.at(-1)!.headers.cookie), "session=2");
  const other = (await m.start("alice", "elsewhere", Math.max(await freePort(), 1024)))!;
  assert.equal(await request(other.local, { headers: { cookie: "session=3" } }).then(() => seen.at(-1)!.headers.cookie), undefined, "not another workspace's");
  await m.stopAll();
  const again = (await m.start("alice", "jar", Math.max(await freePort(), 1024)))!;
  assert.equal(await request(again.local, { headers: { cookie: "session=4" } }).then(() => seen.at(-1)!.headers.cookie), undefined, "forgotten after quitting");
  await m.stopAll();
});

test("a redirect to the app's own name comes back to the forward", async () => {
  const f = await dev();
  const r = await request(f.local, { path: "/redirect" });
  assert.equal(r.status, 302);
  assert.equal(r.headers["location"], `http://127.0.0.1:${f.local}/landed`);
});

test("the port falls to the next free one when taken, and the forward listens on loopback alone", async () => {
  // the same number held by another program, on loopback and (a different case) on every address
  const p = Math.max(await freePort(), 1024);
  const holder = net.createServer();
  await new Promise<void>((r) => holder.listen(p, "127.0.0.1", () => r()));
  const f = (await relay.start("alice", "taken", p))!;
  assert.ok(f.local > p && f.local <= p + 100, `${f.local} for ${p}`);
  const wide = await freePort();
  const holder2 = net.createServer();
  await new Promise<void>((r) => holder2.listen(Math.max(wide, 1024), "0.0.0.0", () => r()));
  const f2 = (await relay.start("alice", "wide", Math.max(wide, 1024)))!;
  assert.notEqual(f2.local, Math.max(wide, 1024), "another program's wildcard listener is not shadowed");
  // a free number is kept as it is
  const q = Math.max(await freePort(), 1024);
  const f3 = (await relay.start("alice", "free", q))!;
  assert.equal(f3.local, q);
  assert.equal(f3.remote, q);
  // a second forward of the same workspace and port is the first one
  assert.equal((await relay.start("alice", "free", q))!.local, q);
  // the same number on ::1 where the Mac has it, and on no other address
  const six = await new Promise<boolean>((resolve) => { const s = net.connect({ host: "::1", port: f3.local }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
  const hasSix = Object.values(os.networkInterfaces()).flat().some((i) => i?.address === "::1");
  assert.equal(six, hasSix);
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (!i || i.internal || i.family !== "IPv4") continue;
    const reached = await new Promise<boolean>((resolve) => { const s = net.connect({ host: i.address, port: f3.local }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
    assert.equal(reached, false, `${i.address} must not answer`);
  }
  holder.close(); holder2.close();
});

test("a forward stops when its workspace is no longer running, when the person stops it, and with the app", async () => {
  const changed: string[] = [];
  const m = new RelayManager(upstream, () => changed.push("changed"));
  const a = (await m.start("alice", "one", Math.max(await freePort(), 1024)))!;
  const b = (await m.start("alice", "two", Math.max(await freePort(), 1024)))!;
  const c = (await m.start("alice", "three", Math.max(await freePort(), 1024)))!;
  const alive = (p: number) => new Promise<boolean>((resolve) => { const s = net.connect({ host: "127.0.0.1", port: p }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
  assert.equal(await alive(a.local), true);
  // the poll shows "one" stopped and "two" still running ("three" is gone from the list)
  await m.reconcile([{ owner: "alice", name: "one", status: "stopped" }, { owner: "alice", name: "two", status: "running" }]);
  assert.equal(await alive(a.local), false);
  assert.equal(await alive(b.local), true);
  assert.equal(await alive(c.local), false);
  assert.deepEqual(m.list().map((f) => f.name), ["two"]);
  await m.reconcile([{ owner: "alice", name: "two", status: "starting" }]);
  assert.equal(await alive(b.local), true, "starting counts as started");
  // an open websocket is cut with it
  const { socket } = await handshake(b.local);
  const closed = new Promise<void>((r) => socket.once("close", () => r()));
  await m.stop(b.id);
  await closed;
  assert.equal(await alive(b.local), false);
  const d = (await m.start("alice", "four", Math.max(await freePort(), 1024)))!;
  await m.stopAll();
  assert.equal(await alive(d.local), false);
  assert.deepEqual(m.list(), []);
  assert.ok(changed.length >= 5);
});

test("a name that is not a plain one is never forwarded, and no name outside ondemand.oerba.dev is ever asked of the stand-in", async () => {
  const before = seen.length;
  for (const [o, w, p] of [["alice", "a.b", 8081], ["alice@github", "demo", 8081], ["alice", "demo", 80], ["alice", "../x", 8081], ["alice", "demo", 70000]] as const) assert.equal(await relay.start(o, w, p), null);
  assert.equal(seen.length, before);
});

test("the menu: a started workspace offers its page and its ports, and a running forward shows its number and a stop", () => {
  const now = { isOwner: false, workspaces: [{ owner: "alice", name: "demo", status: "running" }, { owner: "alice", name: "a.b", status: "running" }], needs: [], deploys: [] };
  const base = { inOerba: true, now, loginItem: false, paletteKey: true, chatKey: true, update: null };
  const labels = labelsOf(buildMenu(base));
  assert.ok(labels.includes("    Open in Oerba") && labels.includes("    Open on localhost:8081") && labels.includes("    Open on localhost:19000"));
  assert.equal(labels.filter((l) => l.includes("Open on localhost:8081")).length, 1, "only for a workspace whose name can be dialled");
  const running = labelsOf(buildMenu({ ...base, forwards: [{ id: "alice/demo:8081", owner: "alice", name: "demo", remote: 8081, local: 8082 }] }));
  assert.ok(running.includes("    localhost:8082 → 8081 (stop)"), running.join("|"));
  assert.ok(!running.includes("    Open on localhost:8081"));
  assert.ok(running.includes("  demo (localhost:8082)"));
  const item = buildMenu({ ...base, forwards: [{ id: "alice/demo:8081", owner: "alice", name: "demo", remote: 8081, local: 8082 }] }).find((i) => i.label === "Workspaces")!.submenu![0]!.submenu!.find((i) => i.label.endsWith("(stop)"))!;
  assert.deepEqual(item.action, { type: "stop", id: "alice/demo:8081" });
  assert.ok(COMMON_PORTS.includes(8081));
});
