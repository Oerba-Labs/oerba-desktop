// Usage: node scripts/finish-latest.mjs <release folder> <version>
// Measures the zip on disk and rewrites <release folder>/latest-mac.yml to list the zip alone (see latest-mac.mjs).
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipOnly } from "./latest-mac.mjs";

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error("usage: finish-latest.mjs <release folder> <version>"); process.exit(2); }
const zipName = `Oerba-${version}-arm64-mac.zip`;
const zipPath = path.join(dir, zipName);
const sha512 = createHash("sha512").update(readFileSync(zipPath)).digest("base64");
const size = statSync(zipPath).size;
const ymlPath = path.join(dir, "latest-mac.yml");
try {
  writeFileSync(ymlPath, zipOnly(readFileSync(ymlPath, "utf8"), zipName, { sha512, size }));
} catch (e) {
  console.error(`latest-mac.yml: ${e.message}`);
  process.exit(1);
}
console.log(`latest-mac.yml now lists ${zipName} alone (sha512 and size checked against the file).`);
