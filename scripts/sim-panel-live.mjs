// A live run of the iPhone panel on this Mac: node scripts/sim-panel-live.mjs <udid> [out-dir] [--packed]. It needs a booted iPhone simulator,
// and changes nothing on the Mac but what the panel itself does while it is open (serve-sim's loader in that simulator, taken out
// again on close). It bundles scripts/live/sim-panel-main.ts with the app's own code into a temporary folder beside the bar's
// bundled files, and runs it with this repository's Electron. Run `npm run build` first. With --packed it runs serve-sim as the
// packaged app carries it (scripts/stage-serve-sim.mjs), rather than the whole package in node_modules.
import { build } from "esbuild";
import { stageServeSim } from "./stage-serve-sim.mjs";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const packed = process.argv.includes("--packed");
const [udid = "", outArg] = process.argv.slice(2).filter((a) => a !== "--packed");
if (!/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(udid)) { console.error("usage: node scripts/sim-panel-live.mjs <udid> [out-dir]"); process.exit(2); }
const dir = mkdtempSync(path.join(tmpdir(), "sim-panel-live-"));
const out = path.resolve(outArg ?? dir);
await build({ entryPoints: ["scripts/live/sim-panel-main.ts"], outfile: path.join(dir, "main.js"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], logLevel: "warning" });
cpSync("dist/preload-simbar.js", path.join(dir, "preload-simbar.js"));
cpSync("dist/simbar", path.join(dir, "simbar"), { recursive: true });
writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "oerba-sim-panel-live", version: "0.0.0", main: "main.js" }));
// serve-sim is found under the app's folder in a development run (src/sim/server.ts), so the folder gets the repository's node_modules.
if (packed) stageServeSim(path.join(dir, "staged")), symlinkSync(path.join(dir, "staged", "node_modules"), path.join(dir, "node_modules"));
else symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));
const electron = path.resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
try {
  execFileSync(electron, [dir], { stdio: "inherit", env: { ...process.env, SIM_LIVE_UDID: udid, SIM_LIVE_OUT: out } });
} catch { process.exit(1); }
