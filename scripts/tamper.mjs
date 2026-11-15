// The forged-update run: electron-updater's real code against a loopback feed that lies about a zip's sha512 (src/tamper.ts).
// It gives the run a scratch folder and an updater cache of its own, starts Electron on dist/tamper.js, and removes both when it
// ends. Only the child it started is ever signalled; any other Oerba or Electron on this Mac is left alone.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const electron = createRequire(import.meta.url)("electron");
const scratch = mkdtempSync(join(tmpdir(), "oerba-tamper-"));
const cacheName = `oerba-desktop-tamper-test-${process.pid}`;
const cleanup = () => { rmSync(scratch, { recursive: true, force: true }); rmSync(join(homedir(), "Library", "Caches", cacheName), { recursive: true, force: true }); };

const child = spawn(electron, ["dist/tamper.js"], { stdio: "inherit", env: { ...process.env, OERBA_TAMPER_DIR: scratch, OERBA_TAMPER_CACHE: cacheName } });
const killer = setTimeout(() => { console.log("tamper: killed after 90 s"); child.kill("SIGKILL"); }, 90_000);
child.on("exit", (code) => { clearTimeout(killer); cleanup(); process.exit(code ?? 1); });
