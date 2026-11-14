import { test } from "node:test";
import assert from "node:assert/strict";
import { configFrom, OERBA_ORIGIN } from "../src/config";

const flags = ["--selftest", "--relay-upstream=http://127.0.0.1:4012", "--oerba-origin=http://127.0.0.1:4010", "--other-origin=http://localhost:4011", "--poll-ms=200"];

test("a packaged app ignores every override, whatever it is given", () => {
  const c = configFrom(["app", ...flags], true);
  assert.deepEqual(c, { oerbaOrigin: OERBA_ORIGIN, selftest: false, otherOrigin: null, pollMs: 30_000, presentMs: null, relayUpstream: null });
});

test("an unpackaged app honours the override only with --selftest", () => {
  const c = configFrom(["electron", ".", ...flags.slice(1)], false);
  assert.equal(c.oerbaOrigin, OERBA_ORIGIN);
  assert.equal(c.selftest, false);
  const d = configFrom(["electron", ".", ...flags], false);
  assert.deepEqual(d, { oerbaOrigin: "http://127.0.0.1:4010", selftest: true, otherOrigin: "http://localhost:4011", pollMs: 200, presentMs: null, relayUpstream: "http://127.0.0.1:4012" });
});

test("the override must be a loopback http origin, and the poll a sane number", () => {
  for (const bad of ["https://evil.example", "http://evil.example:80", "http://127.0.0.1", "http://127.0.0.1:80/path", "http://127.0.0.1.evil.example:80", "file:///x", ""]) {
    assert.equal(configFrom(["--selftest", `--oerba-origin=${bad}`], false).oerbaOrigin, OERBA_ORIGIN, bad);
  }
  for (const bad of ["1", "999999", "abc", ""]) assert.equal(configFrom(["--selftest", `--poll-ms=${bad}`], false).pollMs, 30_000, bad);
});

test("the relay's stand-in must be a loopback http origin, and only an unpackaged --selftest app takes one", () => {
  for (const bad of ["https://127.0.0.1:4012", "http://10.0.0.5:4012", "http://evil.example:80", "http://127.0.0.1", ""]) assert.equal(configFrom(["--selftest", `--relay-upstream=${bad}`], false).relayUpstream, null, bad);
  assert.equal(configFrom(["--relay-upstream=http://127.0.0.1:4012"], false).relayUpstream, null);
  assert.equal(configFrom(["--selftest", "--relay-upstream=http://127.0.0.1:4012"], true).relayUpstream, null);
});

test("the default is the live Oerba and thirty seconds", () => {
  assert.deepEqual(configFrom([], false), { oerbaOrigin: "https://app.oerba.dev", selftest: false, otherOrigin: null, pollMs: 30_000, presentMs: null, relayUpstream: null });
});
