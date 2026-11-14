// The Electron smoke run: two stand-in servers on loopback, the app launched against them with --selftest, and the app's own
// main process asserts (src/selftest.ts) and exits with the status this script returns. Needs the Electron binary
// (node node_modules/electron/install.js) and a desktop session.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");

let open = false;
const page = (title) => `<!doctype html><title>${title}</title><p>${title}</p>`;

const oerba = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/__open") { open = true; res.writeHead(204).end(); return; }
  if (req.url === "/api/who") {
    if (!open) { res.writeHead(503).end("not shared yet"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ known: true, handle: "", person: "nobody", may_act: false, github: "" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(page("stand-in Oerba"));
});
const stranger = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page("a stranger")));

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const [a, b] = [await listen(oerba), await listen(stranger)];

const child = spawn(electron, [".", "--selftest", `--oerba-origin=http://127.0.0.1:${a}`, `--other-origin=http://127.0.0.1:${b}`, "--poll-ms=300"], { stdio: "inherit" });
const killer = setTimeout(() => { console.log("smoke: killed after 90 s"); child.kill("SIGKILL"); }, 90_000);
child.on("exit", (code) => {
  clearTimeout(killer);
  oerba.close(); stranger.close();
  process.exit(code ?? 1);
});
