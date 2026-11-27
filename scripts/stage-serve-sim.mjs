// Stages the part of Expo's serve-sim that the packaged app carries, beside app.asar (electron-builder's extraResources puts the
// folder at Contents/Resources/serve-sim): its command, the native capture it loads, and ws, the one package that command imports.
// Copied from node_modules exactly as npm ci installed them, at the version package.json pins; nothing is built or changed here.
//
// What is left out, and why:
//   - network capture (dist/capture, dist/simnet): a proxy that reads every app's traffic and adds its own root certificate to the
//     simulator's keychain. It starts only with --network-capture, which the app never passes;
//   - camera injection (dist/simcam): a library loaded into apps to feed them a picture as the camera. The panel cannot give it one;
//   - the middleware build (dist/middleware.*), the sources, the maps and the package's own node_modules, which the command does
//     not load (it is one bundled file that imports ws alone).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/** The folders of serve-sim's dist that are carried, beside its command. Each is checked for when it is staged. */
export const CARRIED = ["native", "bin", "capability-loader", "simax", "simpb"];

export function stageServeSim(dest, { from = "node_modules", parts = CARRIED } = {}) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const want = pkg.devDependencies?.["@expo/serve-sim"];
  const src = path.join(from, "@expo", "serve-sim");
  const have = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8")).version;
  if (have !== want) throw new Error(`node_modules holds serve-sim ${have}, package.json pins ${want}: run npm ci`);
  rmSync(dest, { recursive: true, force: true });
  const to = path.join(dest, "node_modules", "@expo", "serve-sim");
  mkdirSync(path.join(to, "dist"), { recursive: true });
  for (const f of ["package.json", "LICENSE", "NOTICE"]) cpSync(path.join(src, f), path.join(to, f));
  cpSync(path.join(src, "dist", "serve-sim.js"), path.join(to, "dist", "serve-sim.js"));
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
  return { version: have, dir: dest };
}
