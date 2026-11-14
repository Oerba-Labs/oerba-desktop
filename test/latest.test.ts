import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import { zipOnly } from "../scripts/latest-mac.mjs";

const ZIP = "Oerba-0.3.0-arm64-mac.zip";
const zip = { sha512: "ZIPSUM==", size: 1000 };
const file = (over: Record<string, unknown> = {}, files?: unknown[]) => yaml.dump({
  version: "0.3.0",
  files: files ?? [{ url: ZIP, sha512: "ZIPSUM==", size: 1000 }, { url: "Oerba-0.3.0-arm64.dmg", sha512: "DMGSUM==", size: 2000 }],
  path: ZIP, sha512: "ZIPSUM==", releaseDate: "2026-11-14T22:06:41.650Z", ...over,
});

test("the dmg's entry goes and the zip's stays, with everything else kept", () => {
  const out = yaml.load(zipOnly(file(), ZIP, zip)) as Record<string, unknown>;
  assert.deepEqual(out["files"], [{ url: ZIP, sha512: "ZIPSUM==", size: 1000 }]);
  assert.equal(out["path"], ZIP);
  assert.equal(out["sha512"], "ZIPSUM==");
  assert.equal(out["version"], "0.3.0");
  assert.equal(out["releaseDate"], "2026-11-14T22:06:41.650Z");
});

test("a file whose first entry is the dmg is handled by name, not by place", () => {
  const dmgFirst = file({}, [{ url: "Oerba-0.3.0-arm64.dmg", sha512: "DMGSUM==", size: 2000 }, { url: ZIP, sha512: "ZIPSUM==", size: 1000 }]);
  const out = yaml.load(zipOnly(dmgFirst, ZIP, zip)) as { files: { url: string }[] };
  assert.deepEqual(out.files.map((f) => f.url), [ZIP]);
});

test("it refuses what does not match the zip on disk, or is not what it expects", () => {
  assert.throws(() => zipOnly(file({ path: "Oerba-0.3.0-arm64.dmg" }), ZIP, zip), /top-level path/);
  assert.throws(() => zipOnly(file({ sha512: "OTHER==" }), ZIP, zip), /top-level sha512/);
  assert.throws(() => zipOnly(file({ size: 5 }), ZIP, zip), /top-level size/);
  assert.throws(() => zipOnly(file(), ZIP, { sha512: "ZIPSUM==", size: 999 }), /size/);
  assert.throws(() => zipOnly(file({}, [{ url: ZIP, sha512: "WRONG==", size: 1000 }]), ZIP, zip), /files list/);
  assert.throws(() => zipOnly(file({}, [{ url: "x.dmg", sha512: "D", size: 1 }]), ZIP, zip), /does not name the zip/);
  assert.throws(() => zipOnly("- a\n- b\n", ZIP, zip), /not a mapping/);
  assert.throws(() => zipOnly("version: 1\n", ZIP, zip), /no files list/);
  assert.throws(() => zipOnly("{{{", ZIP, zip));
});
