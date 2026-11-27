// Stages the part of Expo's serve-sim that the packaged app carries, beside app.asar (electron-builder's extraResources puts the
// folder at Contents/Resources/serve-sim): its command, the native capture it loads, and ws, the one package that command imports.
// Copied from node_modules exactly as npm ci installed them, at the version package.json pins; nothing is built here, and one
// thing is changed, below.
//
// What is left out, and why:
//   - network capture (dist/capture, dist/simnet): a proxy that reads every app's traffic and adds its own root certificate to the
//     simulator's keychain. It starts only with --network-capture, which the app never passes;
//   - camera injection (dist/simcam): a library loaded into apps to feed them a picture as the camera. The panel cannot give it one;
//   - the middleware build (dist/middleware.*), the sources, the maps and the package's own node_modules, which the command does
//     not load (it is one bundled file that imports ws alone).
//
// What is changed, and why (CHANGE below; serve-sim's licence, Apache-2.0, asks that a changed file say so, and it does):
//   - serve-sim opens the device in Device Hub (or Simulator) every time it starts, in the background, and has no switch to stop
//     it. The panel shows the phone itself, and its taps reach the phone with Device Hub closed (tried 26 Nov 2026), so the copy
//     Oerba carries does not open it: the one call that does (its ensureBooted's openHost) is made false.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What was reviewed, with Oerba's one change (CHANGE), as digests of the staged folder (scripts/stage-serve-sim.mjs --digest prints them): `all`, of every file,
    checked as it is staged; `stable`, of the files signing does not change (not the binaries, not a bundle's _CodeSignature),
    checked on the packed app by the release build (scripts/lib-pack.sh). A new version of serve-sim or ws is a new review, and
    new digests written here by hand. */
export const PINNED = {
  serveSim: "0.14.6",
  all: "8034b3f7066371a0986f8d58909f0ddba46510d97dab7ca70dcb53e34bdd0af4",
  stable: "d8444563d92c3efcfdbb09ed14e7372d2cc8eb8198377b69168f84a530b54a3c",
};

const MACHO = new Set(["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "bebafeca"]);
const isMachO = (f) => { const b = readFileSync(f); return b.length >= 4 && MACHO.has(b.subarray(0, 4).toString("hex")); };

/** A digest of a staged (or packed) serve-sim folder: each file's path and SHA-256, in order. With `stable`, the binaries and
    every _CodeSignature folder are left out. */
export function digest(dir, { stable = false } = {}) {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(path.join(dir, d)).sort()) {
      const rel = d ? `${d}/${f}` : f;
      if (statSync(path.join(dir, rel)).isDirectory()) { if (!(stable && f === "_CodeSignature")) walk(rel); }
      else if (!(stable && isMachO(path.join(dir, rel)))) files.push(rel);
    }
  };
  walk("");
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0${createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")}\n`);
  return h.digest("hex");
}

/** The one change to serve-sim's command: exactly this text, found once, made into the other. A new version that no longer has it
    stops the build, to be looked at again. */
export const CHANGE = {
  from: "if(await _0($),J)try{vT($)}catch{}",
  to: "if(await _0($),!1)try{vT($)}catch{}",
  notice: "// Changed by Oerba Labs for Oerba Desktop: this copy does not open Device Hub or Simulator when it starts (ensureBooted's\n" +
    "// openHost is false); the Oerba app's panel shows the device. See scripts/stage-serve-sim.mjs in Oerba-Labs/oerba-desktop.\n",
};

/** The folders of serve-sim's dist that are carried, beside its command. Each is checked for when it is staged. */
export const CARRIED = ["native", "bin", "capability-loader", "simax", "simpb"];

export function stageServeSim(dest, { from = "node_modules", parts = CARRIED } = {}) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const want = pkg.devDependencies?.["@expo/serve-sim"];
  if (want !== PINNED.serveSim) throw new Error(`package.json pins serve-sim ${want}, but what was reviewed is ${PINNED.serveSim}`);
  const src = path.join(from, "@expo", "serve-sim");
  const have = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8")).version;
  if (have !== want) throw new Error(`node_modules holds serve-sim ${have}, package.json pins ${want}: run npm ci`);
  rmSync(dest, { recursive: true, force: true });
  const to = path.join(dest, "node_modules", "@expo", "serve-sim");
  mkdirSync(path.join(to, "dist"), { recursive: true });
  for (const f of ["package.json", "LICENSE", "NOTICE"]) cpSync(path.join(src, f), path.join(to, f));
  const command = readFileSync(path.join(src, "dist", "serve-sim.js"), "utf8");
  if (command.split(CHANGE.from).length !== 2) throw new Error(`serve-sim ${have}'s command no longer holds the text Oerba changes: look at it again`);
  const [shebang, rest] = command.startsWith("#!") ? [command.slice(0, command.indexOf("\n") + 1), command.slice(command.indexOf("\n") + 1)] : ["", command];
  writeFileSync(path.join(to, "dist", "serve-sim.js"), shebang + CHANGE.notice + rest.split(CHANGE.from).join(CHANGE.to));
  for (const d of parts) {
    const p = path.join(src, "dist", d);
    if (!existsSync(p)) throw new Error(`serve-sim ${have} has no dist/${d}`);
    // verbatimSymlinks keeps a framework's relative links (Versions/Current and the rest) as links, as codesign expects them.
    cpSync(p, path.join(to, "dist", d), { recursive: true, verbatimSymlinks: true, filter: (f) => !f.endsWith(".map") });
  }
  // ws: its CommonJS entry, its ESM wrapper (serve-sim imports it as a module) and its library, with its licence.
  const ws = path.join(from, "ws");
  const wsTo = path.join(dest, "node_modules", "ws");
  mkdirSync(wsTo, { recursive: true });
  for (const f of ["package.json", "LICENSE", "index.js", "wrapper.mjs"]) cpSync(path.join(ws, f), path.join(wsTo, f));
  cpSync(path.join(ws, "lib"), path.join(wsTo, "lib"), { recursive: true });
  const got = digest(dest);
  if (got !== PINNED.all && !process.env.STAGE_SERVE_SIM_DIGEST) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`the staged serve-sim is not what was reviewed (digest ${got}, pinned ${PINNED.all}): run npm ci, or review the new copy`);
  }
  return { version: have, dir: dest };
}

// node scripts/stage-serve-sim.mjs --digest       stages into a scratch folder and prints both digests, to pin after a review;
// node scripts/stage-serve-sim.mjs --check <dir>  checks a packed Resources/serve-sim folder against `stable`.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--digest") {
    process.env.STAGE_SERVE_SIM_DIGEST = "1";
    const dir = path.join("build", "serve-sim-digest");
    stageServeSim(dir);
    console.log(JSON.stringify({ all: digest(dir), stable: digest(dir, { stable: true }) }, null, 2));
    rmSync(dir, { recursive: true, force: true });
  } else if (process.argv[2] === "--check" && process.argv[3]) {
    const got = digest(process.argv[3], { stable: true });
    if (got !== PINNED.stable) { console.error(`the packed serve-sim is not what was reviewed (stable digest ${got}, pinned ${PINNED.stable})`); process.exit(1); }
    console.log("the packed serve-sim's scripts and files are what was reviewed");
  } else { console.error("usage: node scripts/stage-serve-sim.mjs --digest | --check <Resources/serve-sim>"); process.exit(2); }
}
