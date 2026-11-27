import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSimbarSender, navigationAllowed, type NavPolicy } from "../src/policy/navigation";
import { bundledFile, SIMBAR_URL } from "../src/policy/bundled";
import { BAR_HEIGHT, isSimPage, panelWidth, previewRequestAllowed, previewUrl, readyLine, serveSimArgs, serveSimEnv, SERVE_SIM_VERSION, simOrigin } from "../src/sim/serve";
import { openInSimulator, showDevice, type Ran, type Runner } from "../src/sim/run";

const UDID = "265CBECB-2CF9-4E96-A149-C2CAEFC1AE27";
const TOKEN = "Abc-123._~xyzXYZ0123456789";

test("serve-sim is started with its token gate, loopback alone, one device, no clipboard reader, and no port of its own", () => {
  const a = serveSimArgs(UDID)!;
  assert.deepEqual(a, ["--require-token", "--host", "127.0.0.1", "--single-device", UDID, "--disable", "clipboard", "--disable-share", UDID]);
  // A port given is the only one serve-sim tries; with none, it finds a free one from 3200 and says which.
  for (const forbidden of ["0.0.0.0", "--allow-any-host-when-insecure", "--cors-origin", "--frame-ancestor", "--network-capture", "--detach", "--no-preview", "--enable", "--port", "-p"]) assert.ok(!a.includes(forbidden), forbidden);
  for (const u of ["not-a-udid", `${UDID}\n`, `${UDID} --host 0.0.0.0`, null, 3200]) assert.equal(serveSimArgs(u), null, String(u));
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

test("the serve-sim a run uses is the staged copy, which does not open Device Hub, and says it was changed", () => {
  // npm test builds first, and the development build stages serve-sim beside its bundle (scripts/build.mjs).
  const staged = readFileSync("dist/resources/serve-sim/node_modules/@expo/serve-sim/dist/serve-sim.js", "utf8");
  const original = readFileSync("node_modules/@expo/serve-sim/dist/serve-sim.js", "utf8");
  assert.ok(staged.startsWith("#!/usr/bin/env node\n// Changed by Oerba Labs for Oerba Desktop"), staged.slice(0, 80));
  assert.equal(original.split("if(await _0($),J)try{vT($)}catch{}").length, 2, "the original opens Device Hub at exactly one place");
  assert.ok(!staged.includes("if(await _0($),J)try{vT($)}catch{}") && staged.includes("if(await _0($),!1)try{vT($)}catch{}"));
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

test("the preview's requests reach serve-sim's origin alone", () => {
  const o = "http://127.0.0.1:3200";
  for (const url of ["http://127.0.0.1:3200/", "http://127.0.0.1:3200/api/screenshot?x=1", "ws://127.0.0.1:3200/exec-ws", "data:image/png;base64,AAAA", "blob:http://127.0.0.1:3200/4f1c-uuid"]) {
    assert.equal(previewRequestAllowed(url, o), true, url);
  }
  for (const url of ["http://127.0.0.1:3201/", "http://localhost:3200/", "https://127.0.0.1:3200/", "wss://127.0.0.1:3200/x", "https://example.com/", "https://chrome-devtools-frontend.appspot.com/x",
    "http://u:p@127.0.0.1:3200/", "blob:https://example.com/uuid", "blob:http://127.0.0.1:3201/uuid", "file:///etc/hosts", "oerba-app://app/simbar/simbar.html", "not a url"]) {
    assert.equal(previewRequestAllowed(url, o), false, url);
  }
  assert.equal(previewRequestAllowed("http://127.0.0.1:3200/", null), false, "no preview running: no request");
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

test("the panel's bar offers Close alone: no Pop out, in its page, its script or its bridge (taken off in 0.5.2)", () => {
  const page = readFileSync("static/simbar.html", "utf8");
  assert.deepEqual([...page.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]), ["close"]);
  for (const f of ["static/simbar.html", "src/renderer/simbar.ts", "src/preload-simbar.ts", "src/sim/panel.ts"]) {
    assert.ok(!/"popout"|popOut\(/.test(readFileSync(f, "utf8")), f);
  }
});

test("showDevice (a press without the panel) shows the device by bundle id, and only a UUID-shaped device", async () => {
  const { run, calls } = standIn();
  assert.equal(await showDevice(UDID, run), true);
  assert.deepEqual(calls, [`/usr/bin/open -b com.apple.dt.Devices devices://device/open?id=${UDID}`]);
  const other = standIn();
  assert.equal(await showDevice("x; rm -rf /", other.run), false);
  assert.deepEqual(other.calls, []);
});
