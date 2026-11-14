import { test } from "node:test";
import assert from "node:assert/strict";
import { LinkOutGate } from "../src/policy/linkout";
import { RefusalLog } from "../src/policy/refusals";
import { unexpectedSwitches } from "../src/policy/argv";

test("a frame inside Oerba's page never opens the browser, press or not", () => {
  const g = new LinkOutGate();
  g.noteGesture(1000);
  assert.equal(g.decide(false, 1001), "origin");
  assert.equal(g.decide(true, 1002), "open");   // the press was not spent by the refusal
});

test("Oerba's own top frame needs a press just before, and one press opens one link", () => {
  const g = new LinkOutGate();
  assert.equal(g.decide(true, 5000), "gesture");
  g.noteGesture(5000);
  assert.equal(g.decide(true, 5500), "open");
  assert.equal(g.decide(true, 5501), "gesture");
  g.noteGesture(6000);
  assert.equal(g.decide(true, 6000 + 2001), "gesture");
});

test("no more than five links a minute, then again after it", () => {
  const g = new LinkOutGate();
  let t = 10_000;
  for (let i = 0; i < 5; i++) { g.noteGesture(t); assert.equal(g.decide(true, t), "open"); t += 100; }
  g.noteGesture(t);
  assert.equal(g.decide(true, t), "rate");
  t += 60_000;
  g.noteGesture(t);
  assert.equal(g.decide(true, t), "open");
});

test("the refusal record keeps the newest 200 and counts them all", () => {
  const log = new RefusalLog(200);
  for (let i = 0; i < 1000; i++) log.push(`r${i}`);
  assert.equal(log.list.length, 200);
  assert.equal(log.total, 1000);
  assert.equal(log.list[0], "r800");
  assert.equal(log.has("r999"), true);
  assert.equal(log.has("r0"), false);
});

test("a normal launch carries no switch; any other is named", () => {
  assert.deepEqual(unexpectedSwitches([]), []);
  assert.deepEqual(unexpectedSwitches(["-psn_0_123456"]), []);
  assert.deepEqual(unexpectedSwitches(["/Users/x/file.txt", "https://app.oerba.dev/x"]), []);
  for (const bad of ["--inspect", "--inspect-brk=9229", "--remote-debugging-port=9222", "--no-sandbox", "--disable-web-security", "--js-flags=--expose-gc", "--user-data-dir=/tmp/x", "--", "-psn_0_1\n", "-psn_x_1", "-psn_0_1 --x", "--selftest", "-x"])
    assert.deepEqual(unexpectedSwitches(["ok", bad]), [bad], JSON.stringify(bad));
});
