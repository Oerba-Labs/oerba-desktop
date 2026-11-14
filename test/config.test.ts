import { test } from "node:test";
import assert from "node:assert/strict";
import { configFrom, OERBA_ORIGIN } from "../src/config";

const flags = ["--selftest", "--oerba-origin=http://127.0.0.1:4010", "--other-origin=http://localhost:4011", "--poll-ms=200"];

test("a packaged app ignores every override, whatever it is given", () => {
  const c = configFrom(["app", ...flags], true);
  assert.deepEqual(c, { oerbaOrigin: OERBA_ORIGIN, selftest: false, otherOrigin: null, pollMs: 30_000 });
});

test("an unpackaged app honours the override only with --selftest", () => {
  const c = configFrom(["electron", ".", ...flags.slice(1)], false);
  assert.equal(c.oerbaOrigin, OERBA_ORIGIN);
  assert.equal(c.selftest, false);
  const d = configFrom(["electron", ".", ...flags], false);
  assert.deepEqual(d, { oerbaOrigin: "http://127.0.0.1:4010", selftest: true, otherOrigin: "http://localhost:4011", pollMs: 200 });
});

test("the override must be a loopback http origin, and the poll a sane number", () => {
  for (const bad of ["https://evil.example", "http://evil.example:80", "http://127.0.0.1", "http://127.0.0.1:80/path", "http://127.0.0.1.evil.example:80", "file:///x", ""]) {
    assert.equal(configFrom(["--selftest", `--oerba-origin=${bad}`], false).oerbaOrigin, OERBA_ORIGIN, bad);
  }
  for (const bad of ["1", "999999", "abc", ""]) assert.equal(configFrom(["--selftest", `--poll-ms=${bad}`], false).pollMs, 30_000, bad);
});

test("the default is the live Oerba and thirty seconds", () => {
  assert.deepEqual(configFrom([], false), { oerbaOrigin: "https://app.oerba.dev", selftest: false, otherOrigin: null, pollMs: 30_000 });
});
