import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceMemory, MAX_REMEMBERED, parseAllowed, parsePanelDevice, parseRemembered, serialiseRemembered, workspaceKey } from "../src/sim/remember";

const A = "265CBECB-2CF9-4E96-A149-C2CAEFC1AE27";
const B = "1ABFBD1E-2DB7-4466-827C-5D6B2FC49AC9";

test("a workspace is remembered by its owner and name in On-Demand's shape, without regard to case", () => {
  assert.equal(workspaceKey("Alice", "Demo"), "alice/demo");
  for (const [o, n] of [["a.b", "demo"], ["alice", "de/mo"], ["alice@github", "demo"], ["", "demo"], ["alice", "--x"], ["alice", "x\n"]]) assert.equal(workspaceKey(o!, n!), null, `${o}/${n}`);
});

test("the file is read held to its shape: anything else is left out, and a file that is not JSON is empty", () => {
  const good = { key: "alice/demo", udid: A, name: "iPhone 17 Pro" };
  const text = JSON.stringify({ workspaces: [good, { key: "../x", udid: A, name: "x" }, { key: "alice/b", udid: "booted", name: "x" }, { key: "alice/c", udid: A, name: "bad\nname" }, { key: "alice/d", udid: A, name: "" }, null, 5] });
  assert.deepEqual([...parseRemembered(text)], [["alice/demo", { udid: A, name: "iPhone 17 Pro" }]]);
  for (const junk of ["", "not json", "null", "[]", '{"workspaces":{}}']) assert.equal(parseRemembered(junk).size, 0, junk);
  assert.deepEqual([...parseRemembered(serialiseRemembered(parseRemembered(text)))], [...parseRemembered(text)], "what is written reads back the same");
});

test("a device set is the newest entry, kept to a file of the person's alone, and read back by a new run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oerba-remember-"));
  const file = path.join(dir, "sub", "devices.json");
  const m = new DeviceMemory(file);
  assert.equal(m.get("alice", "demo"), null);
  m.set("alice", "demo", { udid: A, name: "iPhone 17 Pro" });
  m.set("Alice", "Demo", { udid: B, name: "iPhone 18 Pro Max" });
  assert.deepEqual(m.get("alice", "demo"), { udid: B, name: "iPhone 18 Pro Max" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new DeviceMemory(file).get("ALICE", "demo"), { udid: B, name: "iPhone 18 Pro Max" });
  m.set("alice", "x.y", { udid: A, name: "n" });
  m.set("alice", "other", { udid: "not-a-udid", name: "n" });
  assert.equal(parseRemembered(readFileSync(file, "utf8")).size, 1, "a workspace or device not of the shape is not remembered");
});

test("at most MAX_REMEMBERED workspaces are kept, the oldest going first", () => {
  const m = new DeviceMemory(null);
  for (let i = 0; i <= MAX_REMEMBERED; i++) m.set("alice", `w${i}`, { udid: A, name: "iPhone" });
  assert.equal(m.get("alice", "w0"), null);
  assert.notEqual(m.get("alice", `w${MAX_REMEMBERED}`), null);
});

test("a file that cannot be read or written leaves the memory in this run alone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oerba-remember-"));
  const file = path.join(dir, "devices.json");
  writeFileSync(file, "{ broken");
  const m = new DeviceMemory(file);
  assert.equal(m.get("alice", "demo"), null);
  m.set("alice", "demo", { udid: A, name: "iPhone" });
  assert.deepEqual(m.get("alice", "demo"), { udid: A, name: "iPhone" });
  const blocked = new DeviceMemory(path.join(file, "cannot", "be", "here.json"));
  blocked.set("alice", "demo", { udid: A, name: "iPhone" });
  assert.deepEqual(blocked.get("alice", "demo"), { udid: A, name: "iPhone" });
});

test("the device the dev panel last showed is kept beside the workspaces', held to the same shape", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oerba-remember-"));
  const file = path.join(dir, "devices.json");
  const m = new DeviceMemory(file);
  assert.equal(m.getPanel(), null);
  m.set("alice", "demo", { udid: A, name: "iPhone 17 Pro" });
  m.setPanel({ udid: B, name: "iPhone 18 Pro Max" });
  m.setPanel({ udid: "booted", name: "x" });
  m.setPanel({ udid: A, name: "bad\nname" });
  const again = new DeviceMemory(file);
  assert.deepEqual(again.getPanel(), { udid: B, name: "iPhone 18 Pro Max" });
  assert.deepEqual(again.get("alice", "demo"), { udid: A, name: "iPhone 17 Pro" }, "the workspaces are kept with it");
  for (const junk of ["", "{}", '{"panel":null}', '{"panel":{"udid":"x","name":"n"}}', `{"panel":{"udid":"${A}","name":""}}`]) assert.equal(parsePanelDevice(junk), null, junk);
  assert.ok(!serialiseRemembered(new Map()).includes("panel"), "no panel device, no entry");
});

test("a workspace's yes to run in the simulator is kept beside the devices, held to the key's shape, and all let go at once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oerba-remember-"));
  const file = path.join(dir, "devices.json");
  const m = new DeviceMemory(file);
  assert.equal(m.isAllowed("alice", "demo"), false, "nothing is allowed until the person says so");
  m.set("alice", "demo", { udid: A, name: "iPhone 17 Pro" });
  m.allow("Alice", "Demo");
  m.allow("alice", "x.y");
  m.allow("alice@github", "demo");
  const again = new DeviceMemory(file);
  assert.equal(again.isAllowed("alice", "demo"), true, "kept across runs, whatever the case");
  assert.equal(again.isAllowed("alice", "other"), false);
  assert.equal(again.allowedCount(), 1, "a name not of the shape is not kept");
  assert.deepEqual(again.get("alice", "demo"), { udid: A, name: "iPhone 17 Pro" }, "the devices are kept with it");
  again.forgetAllowed();
  const after = new DeviceMemory(file);
  assert.equal(after.isAllowed("alice", "demo"), false, "forgotten, it is asked again");
  assert.deepEqual(after.get("alice", "demo"), { udid: A, name: "iPhone 17 Pro" }, "and the devices stay");
  for (const junk of ["", "{}", '{"allowed":{}}', '{"allowed":["../x", 5, null, "Alice/Demo", "a/b/c"]}']) assert.deepEqual(parseAllowed(junk), [], junk);
  assert.deepEqual(parseAllowed('{"allowed":["alice/demo","bob/x","alice/demo"]}'), ["bob/x", "alice/demo"], "each once, the newest last");
  assert.ok(!serialiseRemembered(new Map()).includes("allowed"), "none allowed, no entry");
});

test("at most MAX_REMEMBERED workspaces are allowed, the oldest yes going first", () => {
  const m = new DeviceMemory(null);
  for (let i = 0; i <= MAX_REMEMBERED; i++) m.allow("alice", `w${i}`);
  assert.equal(m.isAllowed("alice", "w0"), false);
  assert.equal(m.isAllowed("alice", `w${MAX_REMEMBERED}`), true);
  assert.equal(m.allowedCount(), MAX_REMEMBERED);
});

test("a Forget whose file cannot be written says so, rather than letting the yes come back at the next start unsaid", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oerba-remember-"));
  const blocker = path.join(dir, "not-a-folder");
  writeFileSync(blocker, "x");
  const m = new DeviceMemory(path.join(blocker, "devices.json"));
  m.allow("alice", "demo");
  assert.equal(m.isAllowed("alice", "demo"), true, "held in memory, though not written");
  assert.equal(m.forgetAllowed(), false);
  assert.equal(m.isAllowed("alice", "demo"), false, "and let go in memory at once");
  assert.equal(new DeviceMemory(null).forgetAllowed(), true, "no file, nothing to fail");
});
