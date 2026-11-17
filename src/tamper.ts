/* The forged-update run (npm run tamper): electron-updater's real code, set as the app sets it (askOnly), driven by the app's own
   Updater, against a feed on loopback. The feed offers version 99.0.0 as a zip whose listed sha512 is wrong, and then the same zip
   with its true sum as a control. Entered only by scripts/tamper.mjs, which gives it a scratch folder and a cache name of its own;
   it is built into dist/ alone, never into the packaged app. It never calls quitAndInstall, and ends in app.exit(). */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { askOnly, Updater, type Engine } from "./update/updater";

/** The scratch folder is removed whole at the end, so it is taken only as scripts/tamper.mjs makes it: an empty folder named
    oerba-tamper-XXXXXX directly in the system's temporary folder, links resolved. Any other value (the home folder, set by hand) is
    refused before anything is written or removed. */
function scratchFolder(given: string): string | null {
  try {
    const real = realpathSync(given);
    if (dirname(real) !== realpathSync(tmpdir()) || !/^oerba-tamper-[A-Za-z0-9]{6}$/.test(basename(real))) return null;
    if (!statSync(real).isDirectory() || readdirSync(real).length !== 0) return null;
    return real;
  } catch { return null; }
}
const scratch = scratchFolder(process.env["OERBA_TAMPER_DIR"] ?? "") ?? "";
const cacheName = process.env["OERBA_TAMPER_CACHE"] ?? "";
if (!scratch || !/^oerba-desktop-tamper-test-[0-9]+$/.test(cacheName)) { console.log("FAIL run it by npm run tamper"); app.exit(2); throw new Error("not started by scripts/tamper.mjs"); }
// Before ready: nothing of this run is written to the installed app's folders.
app.setPath("userData", join(scratch, "userData"));
app.setPath("sessionData", join(scratch, "sessionData"));
app.setPath("logs", join(scratch, "logs"));
app.dock?.hide();

const cacheDir = join(homedir(), "Library", "Caches", cacheName);   // where electron-updater keeps what it downloads (getAppCacheDir)
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const files = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])); } catch { return []; }
};
const sha512 = (b: Buffer): string => createHash("sha512").update(b).digest("base64");

async function main(): Promise<void> {
  // The package: a zip holding a text file and no .app bundle, so no installer could install it.
  const stuff = join(scratch, "stuff"); mkdirSync(stuff);
  writeFileSync(join(stuff, "README.txt"), "not an app bundle: the forged-update test's package\n");
  const zipName = "Oerba-99.0.0-mac.zip";
  execFileSync("/usr/bin/zip", ["-q", "-j", join(scratch, zipName), join(stuff, "README.txt")]);
  const zip = readFileSync(join(scratch, zipName));
  const truth = sha512(zip), lie = sha512(Buffer.from("some other file's bytes"));

  let listed = lie;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];   // electron-updater adds a cache-busting query to the manifest
    requests.push(`${req.method} ${path}`);
    if (path === "/latest-mac.yml") {
      res.writeHead(200, { "content-type": "text/yaml" }).end(`version: 99.0.0\nfiles:\n  - url: ${zipName}\n    sha512: ${listed}\n    size: ${zip.length}\npath: ${zipName}\nsha512: ${listed}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);
    } else if (path === `/${zipName}`) {
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length }).end(zip);
    } else res.writeHead(404).end();
  });
  const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));

  // electron-updater's dev-config route: the feed is a file of ours, read instead of the packaged app's app-update.yml, only here.
  const config = join(scratch, "dev-app-update.yml");
  writeFileSync(config, `provider: generic\nurl: http://127.0.0.1:${port}/\nupdaterCacheDirName: ${cacheName}\n`);
  askOnly(autoUpdater);
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.updateConfigPath = config;
  check("the app's settings are in force", autoUpdater.autoDownload === false && autoUpdater.autoInstallOnAppQuit === false && autoUpdater.allowDowngrade === false);

  let downloadedEvents = 0;
  const errors: Array<{ message: string; code: unknown }> = [];
  autoUpdater.on("update-downloaded", () => { downloadedEvents++; });
  autoUpdater.on("error", (e: Error & { code?: unknown }) => { errors.push({ message: String(e.message), code: e.code }); });

  const run = async (): Promise<Updater> => {
    downloadedEvents = 0; errors.length = 0;
    const updater = new Updater(async () => autoUpdater as unknown as Engine, () => ({ packaged: true, selftest: false, inOerba: true }), () => {});
    await updater.check();
    check("the feed offered 99.0.0", updater.state.phase === "available" && updater.state.version === "99.0.0", `${updater.state.phase} ${updater.state.version}`);
    await updater.download();
    await sleep(300);
    return updater;
  };

  // 1. The tampered case: the manifest lists a sum the zip does not have.
  listed = lie;
  const bad = await run();
  const mismatch = errors.find((e) => /sha512 checksum mismatch, expected .+, got /.test(e.message));
  console.log(`     electron-updater said: ${errors.map((e) => `${String(e.code)}: ${e.message.slice(0, 120)}...`).join(" | ") || "nothing"}`);
  check("tampered: the Updater ended in its error state", bad.state.phase === "failed", bad.state.phase);
  check("tampered: update-downloaded never fired", downloadedEvents === 0);
  check("tampered: the error is electron-updater's checksum mismatch", !!mismatch && mismatch.code === "ERR_CHECKSUM_MISMATCH", mismatch ? String(mismatch.code) : "no such error");
  const left = files(cacheDir);
  check("tampered: no downloaded file is left", left.length === 0, left.join(", "));
  check("tampered: no proxy was made for Squirrel.Mac to fetch from", (autoUpdater as unknown as { server?: unknown }).server == null);
  check("tampered: the zip was fetched, so the refusal was of its bytes", requests.includes(`GET /${zipName}`));

  // 2. The control: the same zip, its true sum. It must get past the checksum, or the case above proves nothing.
  listed = truth;
  const good = await run();
  const sums = errors.filter((e) => /checksum/i.test(e.message));
  console.log(`     control: state ${good.state.phase}, update-downloaded fired ${downloadedEvents}, errors: ${errors.map((e) => e.message.slice(0, 120)).join(" | ") || "none"}`);
  check("control: no checksum error", sums.length === 0);
  const got = files(cacheDir).filter((f) => f.endsWith(".zip") && statSync(f).size === zip.length && sha512(readFileSync(f)) === truth);
  check("control: the download completed and the file is the zip", got.length >= 1, got.map((f) => f.replace(homedir(), "~")).join(", "));
  check("control: update-downloaded fired and the Updater is ready, to ask for Restart (never pressed)", downloadedEvents === 1 && good.state.phase === "ready", `${good.state.phase}, ${downloadedEvents} event(s)`);
  server.closeAllConnections(); server.close();
}

const watchdog = setTimeout(() => { console.log("FAIL timed out"); cleanup(); app.exit(1); }, 60_000);
function cleanup(): void {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
void app.whenReady().then(async () => {
  try { await main(); } catch (e) { console.log(`FAIL ${(e as Error).stack ?? e}`); failed++; }
  clearTimeout(watchdog);
  cleanup();
  console.log(failed ? `tamper: ${failed} FAILED` : "tamper: all passed");
  app.exit(failed ? 1 : 0);
});
