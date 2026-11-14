import { test } from "node:test";
import assert from "node:assert/strict";
import { bundledFile, SETUP_URL, UPDATE_URL } from "../src/policy/bundled";

test("only the app's own six files are served, by the app's own scheme and host", () => {
  assert.deepEqual(bundledFile(SETUP_URL), { relative: "setup/setup.html", type: "text/html; charset=utf-8" });
  assert.equal(bundledFile(UPDATE_URL)?.relative, "update/update.html");
  assert.equal(bundledFile("oerba-app://app/setup/setup.js?x=1#y")?.relative, "setup/setup.js");
  for (const bad of [
    "oerba-app://app/main.js", "oerba-app://app/package.json", "oerba-app://app/setup/../main.js", "oerba-app://app/setup/%2e%2e/main.js",
    "oerba-app://app//setup/setup.html", "oerba-app://other/setup/setup.html", "oerba-app://u:p@app/setup/setup.html", "oerba-app://app/",
    "https://app/setup/setup.html", "file:///setup/setup.html", "nonsense", "",
  ]) assert.equal(bundledFile(bad), null, bad);
});
