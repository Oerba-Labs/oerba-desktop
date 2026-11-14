// The Electron smoke run: two stand-in servers on loopback, the app launched against them with --selftest, and the app's own
// main process asserts (src/selftest.ts) and exits with the status this script returns. Needs the Electron binary
// (node node_modules/electron/install.js) and a desktop session.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");

let open = false;
const base = { owners: ["x"], machines: { m1: { state: { workspaces: [{ name: "demo", owner: "alice", status: "running" }, { name: "other", owner: "bob", status: "running" }] } } }, events: [] };
let nowBody = { ...base, needs_you: [{ machine: "m1", text: "first thing waits" }] };
const second = { ...base, needs_you: [{ machine: "m1", text: "first thing waits" }, { machine: "m1", text: "second thing waits" }],
  machines: { m1: { state: { workspaces: [{ name: "demo", owner: "alice", status: "failed" }] } } },
  events: [{ id: 6, kind: "deploy", subject: "app", summary: "deployed", failed: false }, { id: 5, kind: "deploy", subject: "app", summary: "tests failed", failed: true }, { id: 4, kind: "deploy", subject: "app", summary: "older console, no flag" }] };
const page = (title) => `<!doctype html><title>${title}</title><p>${title}</p>`;

const oerba = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/__open") { open = true; res.writeHead(204).end(); return; }
  if (req.method === "POST" && req.url === "/__now") { nowBody = second; res.writeHead(204).end(); return; }
  if (req.url === "/api/now") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(nowBody)); return; }
  if (req.url === "/api/who") {
    if (!open) { res.writeHead(503).end("not shared yet"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ known: true, handle: "alice", person: "nobody", may_act: false, github: "" }));
    return;
  }
  if (req.url === "/gate") {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>gate</title>
<p><a id="blank" target="_blank" href="https://example.invalid/click-blank">new window</a></p>
<p><a id="same" href="https://example.invalid/click-same">same frame</a></p>
<iframe src="/sub" width="200" height="60"></iframe>
<script>document.addEventListener("keydown", (e) => { if (e.metaKey && e.key === "k") window.__k = (window.__k || 0) + 1; });</script>`);
    return;
  }
  if (req.url === "/sub") {
    // A workspace door running somebody's code: it tries to open the browser, and to send the page above it away.
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><script>
document.addEventListener("keydown", (e) => { if (e.metaKey && e.key === "k") window.__k = (window.__k || 0) + 1; });
for (let i = 0; i < 3; i++) {
  setTimeout(() => { try { window.open("https://example.invalid/sub-open"); } catch {} try { window.top.location = "https://example.invalid/sub-top"; } catch {} }, 100 * i);
}</script>sub`);
    return;
  }
  if (req.url === "/file") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.bin" }).end("x"); return; }
  res.writeHead(200, { "content-type": "text/html" }).end(page("stand-in Oerba"));
});
const stranger = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page("a stranger")));

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const [a, b] = [await listen(oerba), await listen(stranger)];

const child = spawn(electron, [".", "--selftest", `--oerba-origin=http://127.0.0.1:${a}`, `--other-origin=http://127.0.0.1:${b}`, "--poll-ms=300", "--present-ms=400"], { stdio: "inherit" });
const killer = setTimeout(() => { console.log("smoke: killed after 90 s"); child.kill("SIGKILL"); }, 90_000);
child.on("exit", (code) => {
  clearTimeout(killer);
  oerba.close(); stranger.close();
  process.exit(code ?? 1);
});
