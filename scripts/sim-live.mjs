// A live run of src/sim/'s sequence on this Mac, without the app: node scripts/sim-live.mjs [port]. It bundles the module with esbuild
// into a temporary folder, runs it with the real runner, and prints each command and its exit status. It boots a simulator if none is
// booted (the only change the sequence makes) and prints the UDID so the person can shut it down: `xcrun simctl shutdown <udid>`.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = path.join(mkdtempSync(path.join(tmpdir(), "sim-live-")), "run.mjs");
await build({ entryPoints: ["src/sim/run.ts"], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "warning" });
const { openInSimulator, realRunner } = await import(out);
const { describe } = await import(await bundleDecide());

async function bundleDecide() {
  const f = path.join(path.dirname(out), "decide.mjs");
  await build({ entryPoints: ["src/sim/decide.ts"], outfile: f, bundle: true, platform: "node", format: "esm", logLevel: "warning" });
  return f;
}

const port = Number(process.argv[2] ?? 8081);
const run = async (file, args, timeoutMs) => {
  const t = Date.now();
  const r = await realRunner(file, args, timeoutMs);
  console.log(`${r.code === 0 ? "ok" : `exit ${r.code}`}\t${Date.now() - t} ms\t${file} ${args.join(" ")}`);
  return r;
};
const outcome = await openInSimulator(port, run);
console.log(JSON.stringify(outcome));
console.log(JSON.stringify(describe(outcome)));
