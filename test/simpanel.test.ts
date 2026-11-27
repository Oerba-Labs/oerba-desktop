import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSimbarSender, navigationAllowed, type NavPolicy } from "../src/policy/navigation";
import { bundledFile, SIMBAR_URL } from "../src/policy/bundled";
import { BAR_HEIGHT, isSimPage, panelWidth, previewUrl, readyLine, serveSimArgs, serveSimEnv, SERVE_SIM_VERSION, SIM_PORT_FIRST, simOrigin } from "../src/sim/serve";
import { openInSimulator, showDevice, type Ran, type Runner } from "../src/sim/run";

const UDID = "265CBECB-2CF9-4E96-A149-C2CAEFC1AE27";
const TOKEN = "Abc-123._~xyzXYZ0123456789";

test("serve-sim is started with its token gate, loopback alone, one device and no clipboard reader", () => {
  const a = serveSimArgs(UDID, SIM_PORT_FIRST)!;
  assert.deepEqual(a, ["--require-token", "--host", "127.0.0.1", "--single-device", UDID, "--disable", "clipboard", "--disable-share", "--port", "3200", UDID]);
  for (const forbidden of ["0.0.0.0", "--allow-any-host-when-insecure", "--cors-origin", "--frame-ancestor", "--network-capture", "--detach", "--no-preview", "--enable"]) assert.ok(!a.includes(forbidden), forbidden);
  for (const [u, p] of [["not-a-udid", 3200], [`${UDID}\n`, 3200], [`${UDID} --host 0.0.0.0`, 3200], [UDID, 80], [UDID, 70000], [UDID, 3200.5], [UDID, "3200"], [null, 3200]] as const) {
    assert.equal(serveSimArgs(u, p), null, `${String(u)} ${String(p)}`);
  }
});

test("serve-sim's environment is built, and nothing that loads a library passes", () => {
  const env = serveSimEnv({
    HOME: "/Users/someone", TMPDIR: "/var/folders/x/T/", USER: "someone", LOGNAME: "someone", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    PATH: "/tmp/evil:/usr/bin", SERVE_SIM_ADDITIONAL_DYLIBS: "/tmp/x.dylib", SERVE_SIM_SIMPB_DIR: "/tmp/x", SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
    DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", NODE_OPTIONS: "--require /tmp/x.js", ELECTRON_RUN_AS_NODE: "1", SERVE_SIM_MITMDUMP: "/tmp/m",
  });
  assert.deepEqual(env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1", HOME: "/Users/someone", TMPDIR: "/var/folders/x/T/", USER: "someone", LOGNAME: "someone", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" });
  assert.deepEqual(serveSimEnv({ DEVELOPER_DIR: "relative/Xcode" }), { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1" });
});

test("the version carried is the one package.json pins", () => {
  // A devDependency, so that electron-builder does not pack it into app.asar: the app carries it beside (scripts/stage-serve-sim.mjs).
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.equal(pkg.devDependencies?.["@expo/serve-sim"], SERVE_SIM_VERSION, "exact, with no range");
  assert.equal(pkg.dependencies, undefined, "the app has no dependencies of its own for electron-builder to pack");
});

test("the port and token are read from serve-sim's Local line alone", () => {
  assert.deepEqual(readyLine(`[startup] x\n  - Local:   http://localhost:3201/?token=${TOKEN}\n  - Network: use --host`), { port: 3201, token: TOKEN });
  assert.deepEqual(readyLine(`  - Local:   http://127.0.0.1:3200/?token=${TOKEN}`), { port: 3200, token: TOKEN });
  assert.equal(readyLine("[startup] waiting"), null);
  assert.equal(readyLine(`  - Local:   http://localhost:3200/?token=short`), null, "too short to be serve-sim's");
  assert.equal(readyLine(`  - Local:   http://evil.example:3200/?token=${TOKEN}`), null, "a host other than loopback");
  assert.equal(readyLine(`  - Local:   http://localhost:80/?token=${TOKEN}`), null, "a port below 1024");
  assert.equal(readyLine(`  - Local:   http://localhost:3200/?token=${TOKEN}"onload=x`), null, "a token running into other characters");
  assert.equal(readyLine(`  - Local:   http://localhost:3200/?token=${"a".repeat(300)}`), null);
});

test("the preview's address and origin", () => {
  assert.equal(simOrigin(3200), "http://127.0.0.1:3200");
  assert.equal(previewUrl(3200, TOKEN), `http://127.0.0.1:3200/?token=${TOKEN}`);
  assert.equal(isSimPage("http://127.0.0.1:3200/", "http://127.0.0.1:3200"), true);
  assert.equal(isSimPage("http://127.0.0.1:3200/devtools?x=1", "http://127.0.0.1:3200"), true);
  for (const url of ["http://127.0.0.1:3201/", "http://localhost:3200/", "https://127.0.0.1:3200/", "http://u:p@127.0.0.1:3200/", "http://127.0.0.1.evil.example:3200/", "not a url"]) {
    assert.equal(isSimPage(url, "http://127.0.0.1:3200"), false, url);
  }
  assert.equal(isSimPage("http://127.0.0.1:3200/", null), false, "no preview running: nothing is the panel's");
});

test("the panel's views go only where they are for, and make no frames", () => {
  const policy: NavPolicy = { oerbaOrigin: "https://app.oerba.dev", setupUrl: "oerba-app://app/setup/setup.html", updateUrl: "oerba-app://app/update/update.html", simbarUrl: SIMBAR_URL, simOrigin: null };
  assert.equal(navigationAllowed(SIMBAR_URL, true, "simbar", policy), true);
  assert.equal(navigationAllowed("https://app.oerba.dev/", true, "simbar", policy), false);
  assert.equal(navigationAllowed("http://127.0.0.1:3200/", true, "simulator", policy), false, "no preview yet");
  policy.simOrigin = "http://127.0.0.1:3200";
  assert.equal(navigationAllowed("http://127.0.0.1:3200/", true, "simulator", policy), true);
  for (const url of ["http://127.0.0.1:3201/", "https://app.oerba.dev/", "http://localhost:5173/", SIMBAR_URL, "https://example.com/"]) assert.equal(navigationAllowed(url, true, "simulator", policy), false, url);
  for (const role of ["simbar", "simulator"] as const) assert.equal(navigationAllowed("http://127.0.0.1:3200/devtools", false, role, policy), false, `${role} makes no frames`);
  assert.equal(navigationAllowed("http://127.0.0.1:3200/", true, "oerba", policy), false, "Oerba's view is not the preview");
  assert.equal(navigationAllowed("http://127.0.0.1:3200/", true, "other", policy), false);
  assert.equal(isSimbarSender(SIMBAR_URL, true, policy), true);
  assert.equal(isSimbarSender(SIMBAR_URL, false, policy), false);
  assert.equal(isSimbarSender("http://127.0.0.1:3200/", true, policy), false);
  assert.equal(isSimbarSender(policy.updateUrl, true, policy), false);
  for (const f of ["simbar/simbar.html", "simbar/simbar.css", "simbar/simbar.js"]) assert.notEqual(bundledFile(`oerba-app://app/${f}`), null, f);
});

test("the panel takes at most 440 points and never more than half the window", () => {
  assert.equal(panelWidth(1200), 440);
  assert.equal(panelWidth(700), 350);
  assert.equal(panelWidth(0), 0);
  assert.ok(BAR_HEIGHT > 0 && BAR_HEIGHT < 60);
});

function standIn(): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const devices = { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: UDID, name: "iPhone 18 Pro", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro" }] } };
  const run: Runner = async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    const r = (code: number, stdout = ""): Ran => ({ code, stdout });
    if (args[0] === "simctl" && args[1] === "list") return r(0, JSON.stringify(devices));
    return r(0);
  };
  return { run, calls };
}

test("with the panel, the sequence does not open Device Hub, and says which device it used", async () => {
  const { run, calls } = standIn();
  const o = await openInSimulator(8081, run, { window: false });
  assert.deepEqual(o, { kind: "opened", udid: UDID, name: "iPhone 18 Pro", booted: false, port: 8081, shown: true });
  assert.ok(!calls.some((c) => c.startsWith("/usr/bin/open ")), calls.join("\n"));
});

test("Pop out shows the device by bundle id, and only a UUID-shaped device", async () => {
  const { run, calls } = standIn();
  assert.equal(await showDevice(UDID, run), true);
  assert.deepEqual(calls, [`/usr/bin/open -b com.apple.dt.Devices devices://device/open?id=${UDID}`]);
  const other = standIn();
  assert.equal(await showDevice("x; rm -rf /", other.run), false);
  assert.deepEqual(other.calls, []);
});
