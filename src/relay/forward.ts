/* One forward: a listener on the Mac's loopback (127.0.0.1 and ::1, the same number, no other address) that relays HTTP and
   websockets to one workspace port's name under ondemand.oerba.dev. It holds no credential: On-Demand takes the person's
   identity from the Mac's tailnet address. Every request is vetted by rules.ts before anything is dialled, and responses are
   streamed, not held. */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { cleanPath, interstitial, responseHeaders, upstreamHeaders, vet, type Upstream } from "./rules";

/** Limits of one forward. 256 connections each on 127.0.0.1 and ::1 is far above what one dev server's page opens (a browser holds six
    per host; a bundler a few more), and low enough that a runaway local program cannot take the app's descriptors. A request waits
    for upstream at most 15 s to connect and, once connected, 300 s for the answer's headers (Metro's first bundle can take minutes), then 504; neither limit applies once headers have arrived (an event stream, a long download) or a websocket is up; more than 96 in flight (32 sockets and about 64 waiting) answers 503. A websocket is
    never cut for being idle: Metro's hot-reload socket lives as long as the editor. */
export const LIMITS = { maxConnections: 256, connectMs: 15_000, headerMs: 300_000, maxInFlight: 96 };

export interface ForwardSpec {
  name: string; port: number; upstream: Upstream;
  /** Whether the app is forwarding this number on the Mac now for the same owner and workspace (a page of it may call this forward). */
  sibling?: (n: number) => boolean;
  /** The cookie names this workspace's forwards have set, shared by them and kept in memory only. */
  cookies?: Set<string>;
  limits?: Partial<typeof LIMITS>;
}

const GONE = 502;

function refuse(res: http.ServerResponse, status: number, why: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" });
  res.end(`Oerba Desktop's relay refused this request (${why}).\n`);
}

/** A listener on one loopback address, or null when the number is taken or the address does not exist here. */
function listenOn(server: http.Server, host: string, port: number): Promise<"ok" | "taken" | "absent"> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      resolve(e.code === "EADDRINUSE" || e.code === "EACCES" ? "taken" : "absent");
    };
    const onListening = (): void => { server.removeListener("error", onError); resolve("ok"); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

/** Whether something already answers on this number on either loopback address. Binding a specific address beside another program's
    wildcard listener can succeed on macOS, and would then hide that program's own server from the person's browser. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean): void => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export class Forward {
  /** The number on the Mac. */
  port = 0;
  private servers: http.Server[] = [];
  private readonly sockets = new Set<Duplex>();
  private readonly agent: https.Agent | http.Agent;
  private closed = false;
  private inFlight = 0;
  private readonly limits: typeof LIMITS;

  constructor(readonly spec: ForwardSpec) {
    this.limits = { ...LIMITS, ...spec.limits };
    const t = spec.upstream.target(spec.name);
    this.agent = t.secure ? new https.Agent({ keepAlive: true, maxSockets: 32 }) : new http.Agent({ keepAlive: true, maxSockets: 32 });
  }

  connectionLimit(): number | undefined { return this.servers[0]?.maxConnections; }

  /** Bounds a request to upstream: 15 s to connect (502) and 300 s from then to its headers (504). `fail` is called at most once. */
  private guard(up: http.ClientRequest, secure: boolean, fail: (status: number, why: string) => void): void {
    let settled = false;
    const end = (status: number, why: string): void => { if (settled) return; settled = true; fail(status, why); up.destroy(); };
    const timers: NodeJS.Timeout[] = [];
    const clear = (): void => { settled = true; for (const t of timers) clearTimeout(t); };
    up.once("response", clear);
    up.once("upgrade", clear);
    up.once("close", () => { for (const t of timers) clearTimeout(t); });
    up.once("socket", (sock) => {
      const wait = (): void => { timers.push(setTimeout(() => end(504, "the workspace's name did not answer in time"), this.limits.headerMs)); };
      if (!sock.connecting) { wait(); return; }   // a kept connection
      timers.push(setTimeout(() => end(GONE, "the workspace's name did not connect in time"), this.limits.connectMs));
      sock.once(secure ? "secureConnect" : "connect", () => { for (const t of timers) clearTimeout(t); timers.length = 0; if (!settled) wait(); });
    });
  }

  /** Listens on the wanted number if it is free on both loopback addresses, else the next free one, up to `span` numbers on. */
  async listen(wanted: number, taken: (n: number) => boolean = () => false, span = 100): Promise<number> {
    for (let n = wanted; n < Math.min(65536, wanted + span); n++) {
      if (taken(n)) continue;
      if (await answers("127.0.0.1", n) || await answers("::1", n)) continue;
      const v4 = this.make();
      if (await listenOn(v4, "127.0.0.1", n) !== "ok") { v4.close(); continue; }
      const v6 = this.make();
      const r6 = await listenOn(v6, "::1", n);
      if (r6 === "taken") { v4.close(); v6.close(); continue; }
      this.servers = r6 === "ok" ? [v4, v6] : [v4];   // a Mac with no ::1 still serves 127.0.0.1
      this.port = n;
      return n;
    }
    throw new Error("no free port near " + String(wanted));
  }

  private make(): http.Server {
    const server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000, maxHeaderSize: 32_768 }, (req, res) => this.request(req, res));
    server.maxConnections = this.limits.maxConnections;
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
    server.on("connection", (s) => { this.sockets.add(s); s.once("close", () => this.sockets.delete(s)); });
    server.on("clientError", (_e, s) => { if (s.writable) s.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); else s.destroy(); });
    return server;
  }

  private request(req: http.IncomingMessage, res: http.ServerResponse): void {
    const v = vet(req.headers, req.method ?? "", req.url, this.port, (n) => n === this.port || (this.spec.sibling?.(n) ?? false));
    if (!v.ok && v.why === "navigation") {
      // From another site: the relay's own page, nothing forwarded, no cookie set, and nothing of upstream's in it.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(req.method === "HEAD" ? undefined : interstitial(this.port, String(req.headers["host"]), req.url ?? "/"));
      return;
    }
    if (!v.ok) { refuse(res, v.status, v.why); req.resume(); return; }
    if (this.inFlight >= this.limits.maxInFlight) { res.setHeader("retry-after", "1"); refuse(res, 503, "too many requests at once"); req.resume(); return; }
    this.inFlight++;
    res.once("close", () => { this.inFlight--; });
    const { name } = this.spec;
    const t = this.spec.upstream.target(name);
    const headers = upstreamHeaders(req.headers, name, this.spec.cookies);
    const lib = t.secure ? https : http;
    const up = lib.request({ host: t.host, port: t.port, servername: t.secure ? name : undefined, method: req.method, path: cleanPath(req.url ?? "/"), headers, agent: this.agent, setHost: false } as https.RequestOptions, (ures) => {
      const out = responseHeaders(ures.headers, name, String(req.headers["host"]), (c) => { const j = this.spec.cookies; if (j && j.size < 64 && c.length <= 128) j.add(c); });
      res.writeHead(ures.statusCode ?? GONE, ures.statusMessage, out);
      ures.pipe(res);
      ures.once("error", () => res.destroy());
    });
    let answered = false;
    const answer = (status: number, why: string): void => { if (answered) return; answered = true; refuse(res, status, why); };
    up.once("error", () => answer(GONE, "the workspace's name could not be reached"));
    this.guard(up, t.secure, answer);
    res.once("close", () => { if (!up.destroyed && !res.writableFinished) up.destroy(); });
    req.once("error", () => up.destroy());
    req.pipe(up);
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const stop = (status: number, why: string): void => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 421 ? "Misdirected Request" : status === 400 ? "Bad Request" : status === 504 ? "Gateway Timeout" : "Bad Gateway"}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nrefused (${why})\n`);
      else socket.destroy();
    };
    const v = vet(req.headers, req.method ?? "", req.url, this.port, (n) => n === this.port || (this.spec.sibling?.(n) ?? false));
    if (!v.ok) { stop(v.why === "navigation" ? 403 : v.status, v.why); return; }
    if (String(req.headers["upgrade"] ?? "").toLowerCase() !== "websocket" || req.method !== "GET") { stop(400, "upgrade"); return; }
    const { name } = this.spec;
    const t = this.spec.upstream.target(name);
    const headers = upstreamHeaders(req.headers, name, this.spec.cookies);
    headers["connection"] = "Upgrade";
    headers["upgrade"] = "websocket";
    const lib = t.secure ? https : http;
    // No shared agent: an upgraded connection is never given back to a pool.
    const up = lib.request({ host: t.host, port: t.port, servername: t.secure ? name : undefined, method: "GET", path: cleanPath(req.url ?? "/"), headers, agent: false, setHost: false } as https.RequestOptions);
    up.once("upgrade", (ures, usock, uhead) => {
      this.sockets.add(usock);
      usock.once("close", () => { this.sockets.delete(usock); socket.destroy(); });
      socket.once("close", () => usock.destroy());
      const out = responseHeaders(ures.headers, name, String(req.headers["host"]), (c) => { const j = this.spec.cookies; if (j && j.size < 64 && c.length <= 128) j.add(c); });
      out["connection"] = "Upgrade";
      out["upgrade"] = "websocket";
      const lines = Object.entries(out).flatMap(([k, val]) => (Array.isArray(val) ? val : [val]).map((x) => `${k}: ${x.replace(/[\r\n]/g, " ")}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (uhead.length > 0) socket.write(uhead);
      if (head.length > 0) usock.write(head);
      socket.pipe(usock);
      usock.pipe(socket);
      socket.on("error", () => usock.destroy());
      usock.on("error", () => socket.destroy());
    });
    up.once("response", (ures) => {   // the workspace answered without upgrading: the answer goes back, headers cleaned
      const out = responseHeaders(ures.headers, name, String(req.headers["host"]), (c) => { const j = this.spec.cookies; if (j && j.size < 64 && c.length <= 128) j.add(c); });
      const lines = Object.entries(out).flatMap(([k, val]) => (Array.isArray(val) ? val : [val]).map((x) => `${k}: ${x.replace(/[\r\n]/g, " ")}`));
      if (socket.writable) socket.write(`HTTP/1.1 ${ures.statusCode ?? GONE} ${String(ures.statusMessage ?? "").replace(/[\r\n]/g, " ")}\r\n${lines.join("\r\n")}\r\nconnection: close\r\n\r\n`);
      ures.pipe(socket);
    });
    let answered = false;
    const answer = (status: number, why: string): void => { if (answered) return; answered = true; stop(status, why); };
    up.once("error", () => answer(GONE, "the workspace's name could not be reached"));
    this.guard(up, t.secure, answer);
    socket.once("close", () => up.destroy());
    socket.on("error", () => up.destroy());
    up.end();
  }

  /** Stops listening and cuts every connection through it. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const done = this.servers.map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }));
    for (const s of this.sockets) s.destroy();
    this.agent.destroy();
    await Promise.all(done);
  }
}
