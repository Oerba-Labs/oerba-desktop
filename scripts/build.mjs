// Compiles the app with esbuild into dist/, and the tests beside it. Type errors are tsc's (npm run typecheck), not esbuild's.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/setup", { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: "warning" };

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js", platform: "node", format: "cjs", target: "node24", external: ["electron"] });
await build({ ...common, entryPoints: ["src/preload-setup.ts"], outfile: "dist/preload-setup.js", platform: "node", format: "cjs", target: "node24", external: ["electron"] });
await build({ ...common, entryPoints: ["src/renderer/setup.ts"], outfile: "dist/setup/setup.js", platform: "browser", format: "iife", target: "chrome140" });

const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
if (tests.length) {
  await build({ ...common, entryPoints: tests, outdir: "dist/test", platform: "node", format: "cjs", target: "node22" });
}

cpSync("static/setup.html", "dist/setup/setup.html");
cpSync("static/setup.css", "dist/setup/setup.css");
cpSync("static/trayTemplate.png", "dist/trayTemplate.png");
cpSync("static/trayTemplate@2x.png", "dist/trayTemplate@2x.png");
