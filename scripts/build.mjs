// Compiles the app with esbuild. Two bundles of the same source:
//   dist/       the development bundle (npm start, npm test, npm run smoke), which holds the self-test;
//   build/app/  the packaged bundle, which does not: __SELFTEST__ is false there, so the self-test and its flags are
//               compiled out. electron-builder packs only this folder, so tests and scripts are never in the app.asar.
// Type errors are tsc's (npm run typecheck), not esbuild's.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stageServeSim } from "./stage-serve-sim.mjs";

const packaged = process.argv.includes("--app");
const out = packaged ? "build/app" : "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/setup`, { recursive: true });
mkdirSync(`${out}/update`, { recursive: true });
mkdirSync(`${out}/simbar`, { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: "warning", define: { __SELFTEST__: packaged ? "false" : "true" }, legalComments: "none",
  // In the packaged bundle, dead code goes (the self-test behind __SELFTEST__ === false): that needs esbuild to fold the constant, which it does when it simplifies syntax.
  minifySyntax: packaged };
const node = { platform: "node", format: "cjs", target: "node24", external: ["electron"] };

await build({ ...common, ...node, entryPoints: ["src/main.ts"], outfile: `${out}/main.js` });
await build({ ...common, ...node, entryPoints: ["src/preload-setup.ts"], outfile: `${out}/preload-setup.js` });
await build({ ...common, ...node, entryPoints: ["src/preload-update.ts"], outfile: `${out}/preload-update.js` });
await build({ ...common, ...node, entryPoints: ["src/preload-simbar.ts"], outfile: `${out}/preload-simbar.js` });
await build({ ...common, entryPoints: ["src/renderer/setup.ts"], outfile: `${out}/setup/setup.js`, platform: "browser", format: "iife", target: "chrome140" });
await build({ ...common, entryPoints: ["src/renderer/update.ts"], outfile: `${out}/update/update.js`, platform: "browser", format: "iife", target: "chrome140" });
await build({ ...common, entryPoints: ["src/renderer/simbar.ts"], outfile: `${out}/simbar/simbar.js`, platform: "browser", format: "iife", target: "chrome140" });

for (const [from, to] of [["setup.html", "setup/setup.html"], ["setup.css", "setup/setup.css"], ["update.html", "update/update.html"], ["update.css", "update/update.css"], ["simbar.html", "simbar/simbar.html"], ["simbar.css", "simbar/simbar.css"], ["trayTemplate.png", "trayTemplate.png"], ["trayTemplate@2x.png", "trayTemplate@2x.png"]]) {
  cpSync(`static/${from}`, `${out}/${to}`);
}

if (packaged) {
  // The packaged app's own package.json: no dependencies (electron-updater is bundled into main.js), no scripts.
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  writeFileSync(`${out}/package.json`, JSON.stringify({ name: root.name, productName: "Oerba", version: root.version, description: root.description, main: "main.js", author: "Oerba Labs", license: root.license }, null, 2) + "\n");
  // The iPhone panel's helper, beside app.asar rather than in it (electron-builder.yml's extraResources): its native code, and the
  // libraries it hands the simulator, must be files on disk.
  stageServeSim("build/resources/serve-sim");
} else {
  // A development run uses serve-sim as the packed app carries it, changed as it is there (src/sim/server.ts).
  stageServeSim(`${out}/resources/serve-sim`);
  // The forged-update run's own entry (npm run tamper); the packaged bundle above never builds it.
  await build({ ...common, ...node, entryPoints: ["src/tamper.ts"], outfile: "dist/tamper.js", external: ["electron"] });
  const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  if (tests.length) await build({ ...common, entryPoints: tests, outdir: "dist/test", platform: "node", format: "cjs", target: "node22" });
}
