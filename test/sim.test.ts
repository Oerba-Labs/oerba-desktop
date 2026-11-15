import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, EXPO_GO, expoHint, expoUrl, isPort, isUdid, iosVersion, METRO_PORTS, parseDevices, pickDevice } from "../src/sim/decide";
import { OnePress, openInSimulator, type Ran, type Runner } from "../src/sim/run";
import { buildMenu, labelsOf } from "../src/present/menu";
import { parseNow } from "../src/present/now";

// The shape of `xcrun simctl list devices --json` as this Mac printed it (Xcode with iOS 27.0 and 26.5 runtimes, 18.5 and 26.2 with no devices),
// cut to a few devices a runtime and to the fields that matter; the paths it also prints are left out. The runtimes come in the order simctl gave:
// the newest is not last.
const dev = (udid: string, type: string, name: string, state = "Shutdown", isAvailable = true) => ({ udid, isAvailable, deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${type}`, state, name });
const LIST = () => ({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      dev("265CBECB-2CF9-4E96-A149-C2CAEFC1AE27", "iPhone-18-Pro", "iPhone 18 Pro"),
      dev("1ABFBD1E-2DB7-4466-827C-5D6B2FC49AC9", "iPhone-18-Pro-Max", "iPhone 18 Pro Max"),
      dev("8240DE34-DD37-41F4-AC40-AEB85C31DB61", "iPhone-17e", "iPhone 17e"),
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      dev("3D9E8605-2D02-4516-AFB0-FEF1497E5EFF", "iPhone-17-Pro", "iPhone 17 Pro"),
      dev("0FE1D887-A703-470E-BE80-A84AD91DA511", "iPhone-17-Pro-Max", "iPhone 17 Pro Max"),
    ],
  } as Record<string, ReturnType<typeof dev>[]>,
});
const text = (l: unknown): string => JSON.stringify(l);
const FIRST = "265CBECB-2CF9-4E96-A149-C2CAEFC1AE27";

test("a UDID is only the shape of a UUID", () => {
  assert.ok(isUdid(FIRST) && isUdid(FIRST.toLowerCase()));
  for (const bad of ["", "booted", "all", `${FIRST}\n`, ` ${FIRST}`, `${FIRST} --force`, FIRST.slice(1), `${FIRST}0`, "265CBECB-2CF9-4E96-A149-C2CAEFC1AE2G", "../../x", null, undefined, 5, FIRST.replace(/-/g, "")]) assert.equal(isUdid(bad), false, JSON.stringify(bad));
});

test("a device list holding a malformed UDID drops that device, and one that is not available", () => {
  const l = LIST();
  l.devices["com.apple.CoreSimulator.SimRuntime.iOS-27-0"] = [dev("not-a-uuid; rm -rf", "iPhone-18-Pro", "bad"), dev("9A9A9A9A-2CF9-4E96-A149-C2CAEFC1AE27", "iPhone-18", "off", "Shutdown", false), dev(FIRST, "iPhone-18-Pro", "ok")];
  assert.deepEqual(parseDevices(text(l)).filter((d) => d.runtime[0] === 27).map((d) => d.udid), [FIRST]);
  for (const junk of ["", "not json", "null", "[]", '{"devices":[]}', '{"devices":{"x":5}}', '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[null,5,"x"]}}']) assert.deepEqual(parseDevices(junk), [], junk);
});

test("only iOS runtimes count", () => {
  assert.deepEqual(iosVersion("com.apple.CoreSimulator.SimRuntime.iOS-26-5"), [26, 5, 0]);
  assert.deepEqual(iosVersion("com.apple.CoreSimulator.SimRuntime.iOS-27-0"), [27, 0, 0]);
  for (const other of ["com.apple.CoreSimulator.SimRuntime.tvOS-26-5", "com.apple.CoreSimulator.SimRuntime.watchOS-11-0", "com.apple.CoreSimulator.SimRuntime.xrOS-2-0", "iOS-26-5", "com.apple.CoreSimulator.SimRuntime.iOS-x"]) assert.equal(iosVersion(other), null, other);
  const l = LIST();
  l.devices["com.apple.CoreSimulator.SimRuntime.tvOS-27-0"] = [dev("7B7B7B7B-2CF9-4E96-A149-C2CAEFC1AE27", "Apple-TV-4K", "Apple TV 4K", "Booted")];
  assert.equal(pickDevice(parseDevices(text(l))).kind, "boot", "a booted Apple TV is not an iPhone simulator");
});

test("the newest runtime's first iPhone is picked to boot when none is booted, wherever the runtime is in the list", () => {
  const p = pickDevice(parseDevices(text(LIST())));
  assert.equal(p.kind, "boot");
  assert.ok(p.kind === "boot" && p.device.udid === FIRST && p.device.name === "iPhone 18 Pro");
  // 26.10 is newer than 26.5 (numbers, not text).
  const l = LIST();
  delete l.devices["com.apple.CoreSimulator.SimRuntime.iOS-27-0"];
  l.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-10"] = [dev("5C5C5C5C-2CF9-4E96-A149-C2CAEFC1AE27", "iPhone-17", "iPhone 17")];
  const q = pickDevice(parseDevices(text(l)));
  assert.ok(q.kind === "boot" && q.device.udid === "5C5C5C5C-2CF9-4E96-A149-C2CAEFC1AE27");
});

test("a device named by the person is an iPhone by its type, not by its name; an iPad is not one", () => {
  const l = LIST();
  l.devices = { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [dev("6D6D6D6D-2CF9-4E96-A149-C2CAEFC1AE27", "iPad-Pro", "iPhone lookalike"), dev(FIRST, "iPhone-18-Pro", "My phone")] };
  const p = pickDevice(parseDevices(text(l)));
  assert.ok(p.kind === "boot" && p.device.udid === FIRST);
});

test("a booted iOS device is used and nothing is booted", () => {
  const l = LIST();
  l.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-5"]![1]!.state = "Booted";
  const p = pickDevice(parseDevices(text(l)));
  assert.ok(p.kind === "booted" && p.device.udid === "0FE1D887-A703-470E-BE80-A84AD91DA511", JSON.stringify(p));
  // Booted iPhones: the newest runtime's.
  l.devices["com.apple.CoreSimulator.SimRuntime.iOS-27-0"]![2]!.state = "Booted";
  const q = pickDevice(parseDevices(text(l)));
  assert.ok(q.kind === "booted" && q.device.udid === "8240DE34-DD37-41F4-AC40-AEB85C31DB61");
});

test("no iPhone: no devices, none available, only an iPad", () => {
  assert.deepEqual(pickDevice(parseDevices('{"devices":{}}')), { kind: "none" });
  const l = LIST();
  for (const k of Object.keys(l.devices)) for (const d of l.devices[k]!) d.isAvailable = false;
  assert.deepEqual(pickDevice(parseDevices(text(l))), { kind: "none" });
  l.devices = { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [dev(FIRST, "iPad-Pro", "iPad")] };
  assert.deepEqual(pickDevice(parseDevices(text(l))), { kind: "none" });
});

test("the address is built from an integer port alone", () => {
  assert.equal(expoUrl(8081), "exp://127.0.0.1:8081");
  assert.equal(expoUrl(65535), "exp://127.0.0.1:65535");
  assert.equal(expoUrl(8082), "exp://127.0.0.1:8082");
  for (const bad of [0, -1, 65536, 80.5, NaN, Infinity, "8081", "8081/../x", null, undefined, {}, [8081]]) { assert.equal(expoUrl(bad), null, String(bad)); assert.equal(isPort(bad), false); }
  assert.equal(expoHint(8082).body.includes("EXPO_PACKAGER_PROXY_URL=http://127.0.0.1:8082"), true);
  assert.deepEqual([...METRO_PORTS], [8081, 19000]);
});

test("what the person is told for each outcome", () => {
  assert.match(describe({ kind: "no-xcode" }).body, /Install Xcode from the App Store, open it once/);
  assert.match(describe({ kind: "no-xcode" }).body, /iOS platform/);
  assert.match(describe({ kind: "no-expo-go", name: "iPhone 18 Pro" }).body, /Expo Go.*iOS Simulator|iOS Simulator.*install/);
  assert.match(describe({ kind: "opened", name: "iPhone 18 Pro", booted: true, port: 8082, shown: true }).body, /Booted iPhone 18 Pro and opened exp:\/\/127\.0\.0\.1:8082/);
  assert.match(describe({ kind: "opened", name: "iPhone 18 Pro", booted: false, port: 8082, shown: true }).body, /Used iPhone 18 Pro/);
  assert.match(describe({ kind: "opened", name: "iPhone 18 Pro", booted: true, port: 8082, shown: false }).body, /window could not be shown/);
  for (const k of ["no-iphone", "boot-failed", "failed"] as const) assert.ok(describe({ kind: k }).body.length > 0);
});

// ---- the sequence, against a stand-in runner that records what it was asked and boots nothing ---------------------------------

interface Script { xcodeSelect?: number; find?: number; list?: unknown; listCode?: number; boot?: number; bootstatus?: number; container?: number; open?: number; openurl?: number }
function standIn(s: Script): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (file, args, timeoutMs) => {
    assert.ok(file.startsWith("/usr/bin/"), file);
    assert.ok(timeoutMs > 0 && timeoutMs <= 120_000);
    const line = [file, ...args].join(" ");
    calls.push(line);
    const r = (code: number, stdout = ""): Ran => ({ code, stdout });
    if (file === "/usr/bin/xcode-select") return r(s.xcodeSelect ?? 0, "/Applications/Xcode.app/Contents/Developer\n");
    if (file === "/usr/bin/open") return r(s.open ?? 0);
    const a = args.join(" ");
    if (a === "--find simctl") return r(s.find ?? 0);
    if (a === "simctl list devices --json") return r(s.listCode ?? 0, text(s.list ?? LIST()));
    if (a.startsWith("simctl boot ")) return r(s.boot ?? 0);
    if (a.startsWith("simctl bootstatus ")) return r(s.bootstatus ?? 0);
    if (a.startsWith("simctl get_app_container ")) return r(s.container ?? 0);
    if (a.startsWith("simctl openurl ")) return r(s.openurl ?? 0);
    throw new Error(`unexpected command: ${line}`);
  };
  return { run, calls };
}

test("the whole sequence: boots the first iPhone, shows Simulator, finds Expo Go, opens the address", async () => {
  const { run, calls } = standIn({});
  const o = await openInSimulator(8082, run);
  assert.deepEqual(o, { kind: "opened", name: "iPhone 18 Pro", booted: true, port: 8082, shown: true });
  assert.deepEqual(calls, [
    "/usr/bin/xcode-select -p",
    "/usr/bin/xcrun --find simctl",
    "/usr/bin/xcrun simctl list devices --json",
    `/usr/bin/xcrun simctl boot ${FIRST}`,
    `/usr/bin/xcrun simctl bootstatus ${FIRST}`,
    "/usr/bin/open -a Simulator",
    `/usr/bin/xcrun simctl get_app_container ${FIRST} ${EXPO_GO}`,
    `/usr/bin/xcrun simctl openurl ${FIRST} exp://127.0.0.1:8082`,
  ]);
});

test("a booted device is used: nothing is booted", async () => {
  const l = LIST();
  l.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-5"]![0]!.state = "Booted";
  const { run, calls } = standIn({ list: l });
  const o = await openInSimulator(8081, run);
  assert.deepEqual(o, { kind: "opened", name: "iPhone 17 Pro", booted: false, port: 8081, shown: true });
  assert.ok(!calls.some((c) => c.includes(" boot")), calls.join("\n"));
  assert.ok(calls.includes("/usr/bin/xcrun simctl openurl 3D9E8605-2D02-4516-AFB0-FEF1497E5EFF exp://127.0.0.1:8081"));
});

test("Xcode missing: nothing but the check runs", async () => {
  for (const s of [{ xcodeSelect: 2 }, { find: 1 }]) {
    const { run, calls } = standIn(s);
    assert.deepEqual(await openInSimulator(8081, run), { kind: "no-xcode" });
    assert.ok(calls.every((c) => c.startsWith("/usr/bin/xcode-select") || c.includes("--find simctl")), calls.join("\n"));
  }
});

test("Expo Go missing: the address is never opened", async () => {
  const { run, calls } = standIn({ container: 2 });
  assert.deepEqual(await openInSimulator(8081, run), { kind: "no-expo-go", name: "iPhone 18 Pro" });
  assert.ok(!calls.some((c) => c.includes("openurl")), calls.join("\n"));
});

test("no iPhone, a boot that fails, an address that is refused, a list that cannot be read", async () => {
  assert.deepEqual(await openInSimulator(8081, standIn({ list: { devices: {} } }).run), { kind: "no-iphone" });
  const b = standIn({ boot: 1 });
  assert.deepEqual(await openInSimulator(8081, b.run), { kind: "boot-failed" });
  assert.ok(!b.calls.some((c) => c.includes("openurl") || c.startsWith("/usr/bin/open ")));
  assert.deepEqual(await openInSimulator(8081, standIn({ bootstatus: 1 }).run), { kind: "boot-failed" });
  assert.deepEqual(await openInSimulator(8081, standIn({ openurl: 1 }).run), { kind: "open-failed", name: "iPhone 18 Pro" });
  assert.deepEqual(await openInSimulator(8081, standIn({ listCode: 1 }).run), { kind: "failed" });
});

test("Simulator's window that cannot be shown does not stop the address being opened, and is said", async () => {
  const { run, calls } = standIn({ open: 1 });
  assert.deepEqual(await openInSimulator(8081, run), { kind: "opened", name: "iPhone 18 Pro", booted: true, port: 8081, shown: false });
  assert.ok(calls.some((c) => c.includes("openurl")));
});

test("a port that is not a port runs nothing", async () => {
  const { run, calls } = standIn({});
  for (const bad of [0, 70000, 1.5, NaN]) assert.deepEqual(await openInSimulator(bad, run), { kind: "failed" });
  assert.equal(calls.length, 0);
});

test("a malformed UDID in the list never reaches a command", async () => {
  const l = LIST();
  l.devices = { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [dev("booted --erase", "iPhone-18", "x"), dev("all", "iPhone-18", "y")] };
  const { run, calls } = standIn({ list: l });
  assert.deepEqual(await openInSimulator(8081, run), { kind: "no-iphone" });
  assert.ok(calls.every((c) => !c.includes("booted --erase") && !/ all( |$)/.test(c)));
});

test("a second press while one runs is ignored; one after it finishes runs", async () => {
  const press = new OnePress();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let runs = 0;
  const first = press.run(async () => { runs++; await gate; return "a"; });
  assert.equal(press.running, true);
  assert.deepEqual(await press.run(async () => { runs++; return "b"; }), { ran: false });
  release();
  assert.deepEqual(await first, { ran: true, value: "a" });
  assert.equal(runs, 1);
  assert.deepEqual(await press.run(async () => { runs++; return "c"; }), { ran: true, value: "c" });
  // A press that throws lets the next one in.
  await assert.rejects(press.run(async () => { throw new Error("x"); }));
  assert.deepEqual(await press.run(async () => 1), { ran: true, value: 1 });
});

// ---- the menu offers it on Metro's ports and on no web port -----------------------------------------------------------------

test("the menu offers 'in iOS Simulator' on Metro's ports and on no web port", () => {
  const now = parseNow({ owners: ["x"], machines: { m1: { state: { workspaces: [{ name: "demo", owner: "alice", status: "running" }] } } }, events: [], needs_you: [] }, { handle: "alice", github: "" })!;
  const menu = buildMenu({ inOerba: true, now, loginItem: false, paletteKey: true, chatKey: true, update: null, forwards: [{ id: "alice/demo:8081", owner: "alice", name: "demo", remote: 8081, local: 8082 }] });
  const labels = labelsOf(menu).map((l) => l.trim());
  assert.ok(labels.includes("Open 8081 in iOS Simulator") && labels.includes("Open 19000 in iOS Simulator"), labels.join(" | "));
  assert.equal(labels.filter((l) => l.includes("iOS Simulator")).length, 2, "not on a web port, nor 19006");
  const sub = menu.find((m) => m.label === "Workspaces")!.submenu![0]!.submenu!;
  const item = sub.find((m) => m.label === "Open 8081 in iOS Simulator")!;
  assert.deepEqual(item.action, { type: "simulator", owner: "alice", name: "demo", port: 8081 });
});
