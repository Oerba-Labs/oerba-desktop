import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNow, type NowModel } from "../src/present/now";
import { badgeText, decide, freshMemory, Limiter, type Item } from "../src/present/notify";
import { safeRoute, workspaceRoute } from "../src/present/routes";
import { buildMenu, labelsOf } from "../src/present/menu";
import { clean, plainName } from "../src/present/text";
import { OPEN_PALETTE_JS } from "../src/present/palette";
import { notesToText } from "../src/update/notes";
import { getJsonObject, type PresentFetch } from "../src/present/fetch";

const me = { handle: "alice", github: "alice-gh" };
const ws = (owner: string, name: string, status: string) => ({ owner, name, status, healthy: true, outdated: false });
const ownerBody = (extra: object = {}) => ({
  at: 1, owners: ["alice"], needs_you: [{ machine: "m1", text: "m1 has gone quiet", opened: 1, quiet: true }],
  machines: { m1: { state: { workspaces: [ws("alice", "demo", "running"), ws("bob", "theirs", "running"), ws("alice-gh@github", "gh", "stopped")] } }, m2: { state: null } },
  events: [{ id: 7, kind: "deploy", subject: "app", summary: "tests failed", failed: true }, { id: 6, kind: "restart", subject: "x", summary: "", failed: true }, { id: 5, kind: "deploy", subject: "app", summary: "ok", failed: false }, { id: 4, kind: "deploy", subject: "app", summary: "no flag" }],
  ...extra,
});
const developerBody = () => ({ at: 1, needs_you: [], machines: { m1: { state: { workspaces: [ws("bob", "mine", "failed")] } } }, events: [], deploying: [] });

test("an owner's answer: their own workspaces, what waits, and the deploy lines", () => {
  const m = parseNow(ownerBody(), me)!;
  assert.equal(m.isOwner, true);
  assert.deepEqual(m.workspaces.map((w) => `${w.owner}/${w.name}/${w.status}`), ["alice/demo/running", "alice-gh@github/gh/stopped"]);
  assert.deepEqual(m.needs, [{ key: "m1\tm1 has gone quiet", title: "m1 has gone quiet" }]);
  assert.deepEqual(m.deploys.map((d) => [d.id, d.failed]), [[7, true], [5, false], [4, false]]);
});

test("a developer's answer holds theirs already, carries no needs, and is not the owner's", () => {
  const m = parseNow(developerBody(), { handle: "bob", github: "" })!;
  assert.equal(m.isOwner, false);
  assert.deepEqual(m.workspaces.map((w) => w.name), ["mine"]);
  assert.deepEqual(m.needs, []);
  assert.equal(badgeText(m), "");
});

test("malformed answers are nothing or empty, and odd entries are skipped", () => {
  for (const bad of [null, undefined, 3, "x", [], [{}]]) assert.equal(parseNow(bad, me), null);
  const m = parseNow({ owners: [], needs_you: [1, null, { text: 5 }, { text: "ok", machine: 3 }], machines: { a: 1, b: { state: { workspaces: [null, { name: "../x", owner: "alice", status: "running" }, { name: "good", owner: "alice" }, { name: "fine", owner: "alice", status: "running" }] } } }, events: [{ id: "1", kind: "deploy" }, { id: 2.5, kind: "deploy" }, { id: 3, kind: "deploy", failed: true, subject: 4 }, { id: 8, kind: "deploy", failed: "true" }, { id: 9, kind: "deploy", outcome: "failed" }] }, me)!;
  assert.deepEqual(m.workspaces.map((w) => w.name), ["fine"]);
  assert.equal(m.needs.length, 1);
  assert.deepEqual(m.deploys.map((d) => [d.id, d.failed]), [[3, true], [8, false], [9, false]]);   // only failed === true counts; outcome is not read
  assert.deepEqual(parseNow({}, me), { isOwner: false, workspaces: [], needs: [], deploys: [] });
});

test("machine words are held to plain printable characters and a length", () => {
  assert.equal(clean("a\u0000b‮c\nd\te", 50), "a b c d e");
  assert.equal(clean("‮evil⁦", 50), "evil");
  assert.equal(clean("x".repeat(500), 10), "xxxxxxxxx…");
  assert.equal(clean("😀".repeat(20), 5), "😀😀😀😀…");
  assert.equal(clean(42, 5), "");
  const m = parseNow({ owners: [], needs_you: [{ machine: "m", text: "t".repeat(300) + "\u0007" }], machines: {}, events: [] }, me)!;
  assert.equal(Array.from(m.needs[0]!.title).length, 90);
});

const model = (over: Partial<NowModel> = {}): NowModel => ({ isOwner: true, workspaces: [], needs: [], deploys: [], ...over });
const need = (t: string) => ({ key: `m\t${t}`, title: t });

test("the first read is the baseline: nothing is said for what was already so", () => {
  const first = decide(freshMemory(), model({ needs: [need("a")], deploys: [{ id: 9, failed: true, subject: "x", summary: "", }], workspaces: [{ owner: "alice", name: "w", status: "failed" }] }));
  assert.deepEqual(first.items, []);
  assert.equal(decide(first.next, model({ needs: [need("a")], deploys: [{ id: 9, failed: true, subject: "x", summary: "" }], workspaces: [{ owner: "alice", name: "w", status: "failed" }] })).items.length, 0);
});

test("a new need, a failed deploy and a newly failed workspace each make one; success makes none", () => {
  const base = decide(freshMemory(), model({ needs: [need("a")], workspaces: [{ owner: "alice", name: "w", status: "running" }] })).next;
  const r = decide(base, model({
    needs: [need("a"), need("b")],
    deploys: [{ id: 3, failed: false, subject: "x", summary: "fine" }, { id: 2, failed: true, subject: "app", summary: "tests failed" }],
    workspaces: [{ owner: "alice", name: "w", status: "failed" }],
  }));
  assert.deepEqual(r.items.map((i) => [i.title, i.body, i.route]), [
    ["Waiting on you", "b", "#/"], ["A deploy failed", "app: tests failed", "#/"], ["A workspace failed", "w", "#/ws/alice/w"],
  ]);
  const again = decide(r.next, model({ needs: [need("a"), need("b")], deploys: [{ id: 3, failed: false, subject: "x", summary: "fine" }, { id: 2, failed: true, subject: "app", summary: "tests failed" }], workspaces: [{ owner: "alice", name: "w", status: "failed" }] }));
  assert.deepEqual(again.items, []);
});

test("a deploy that went well, or a workspace that came up, says nothing", () => {
  const base = decide(freshMemory(), model()).next;
  const r = decide(base, model({ deploys: [{ id: 1, failed: false, subject: "a", summary: "ok" }], workspaces: [{ owner: "alice", name: "w", status: "running" }] }));
  assert.deepEqual(r.items, []);
});

test("an older failed deploy, seen late, is not news", () => {
  const base = decide(freshMemory(), model({ deploys: [{ id: 10, failed: false, subject: "a", summary: "" }] })).next;
  assert.deepEqual(decide(base, model({ deploys: [{ id: 4, failed: true, subject: "a", summary: "" }] })).items, []);
});

const items = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ title: "t", body: `b${i}`, route: "#/" }));

test("at most five a minute, the rest folded into one 'and n more'", () => {
  const l = new Limiter(5, 60_000);
  assert.equal(l.admit(items(3), 0).length, 3);
  const r = l.admit(items(4), 1000);   // room for two: one shown, the other three folded
  assert.deepEqual(r.map((i) => i.body), ["b0", "and 3 more"]);
  assert.deepEqual(l.admit(items(2), 2000), []);   // none left in this minute, so they are owed
  const later = l.admit([], 61_000);
  assert.deepEqual(later.map((i) => i.body), ["and 2 more"]);
  assert.equal(l.admit(items(5), 61_001).length, 4);   // one slot is already used by the fold
});

test("a big burst makes five notifications, not fifty", () => {
  const out = new Limiter(5, 60_000).admit(items(50), 0);
  assert.equal(out.length, 5);
  assert.equal(out[4]!.body, "and 46 more");
});

test("the badge counts what waits on the owner, and nothing for anyone else or at zero", () => {
  assert.equal(badgeText(null), "");
  assert.equal(badgeText(model()), "");
  assert.equal(badgeText(model({ needs: [need("a"), need("b")] })), "2");
  assert.equal(badgeText(model({ isOwner: false, needs: [need("a")] })), "");
  assert.equal(badgeText(model({ needs: Array.from({ length: 120 }, (_, i) => need(String(i))) })), "99+");
});

test("a workspace's route is encoded, and an odd name has none", () => {
  assert.equal(workspaceRoute("alice", "demo-1"), "#/ws/alice/demo-1");
  assert.equal(workspaceRoute("alice@github", "a.b_c"), "#/ws/alice%40github/a.b_c");
  for (const bad of ["", "../x", "a/b", "a b", "a?b", "a#b", "-x", ".x", "x".repeat(65), "é", "a\n", "%2e%2e", 5, null, undefined]) {
    assert.equal(workspaceRoute("alice", bad), null, String(bad));
    assert.equal(workspaceRoute(bad, "demo"), null, String(bad));
  }
  assert.equal(safeRoute("#/ws/alice/demo"), true);
  assert.equal(safeRoute("#/"), true);
  for (const bad of ["", "#", "/x", "#/a b", "#/../x", "#/x\n", "javascript:1", "#/x';alert(1)//", 5]) assert.equal(safeRoute(bad), false, String(bad));
});

test("the menu: an owner's has everything, a developer's has no waiting entry, and before setup is done only the basics", () => {
  const owner = labelsOf(buildMenu({ inOerba: true, now: model({ workspaces: [{ owner: "alice", name: "demo", status: "running" }, { owner: "alice", name: "off", status: "stopped" }], needs: [need("a")] }), loginItem: false, paletteKey: true, chatKey: true, update: null }));
  assert.deepEqual(owner, ["Open Oerba", "Workspaces", "  demo", "    Open in Oerba", "    Open on localhost:3000", "    Open on localhost:5173", "    Open on localhost:8000", "    Open on localhost:8080", "    Open on localhost:8081", "    Open on localhost:19000", "    Open on localhost:19006", "    Open 8081 in iOS Simulator", "    Open 19000 in iOS Simulator", "Waiting on you (1)", "New chat", "Switch workspace…", "Open at login", "Quit Oerba"]);
  const dev = labelsOf(buildMenu({ inOerba: true, now: model({ isOwner: false }), loginItem: false, paletteKey: true, chatKey: true, update: null }));
  assert.equal(dev.some((l) => l.startsWith("Waiting")), false);
  assert.deepEqual(labelsOf(buildMenu({ inOerba: false, now: null, loginItem: false, paletteKey: true, chatKey: true, update: null })), ["Open Oerba", "Open at login", "Quit Oerba"]);
});

test("a shortcut another app holds is said in the menu, not as an error; the login item changes nothing until ticked", () => {
  const items = buildMenu({ inOerba: true, now: null, loginItem: true, paletteKey: false, chatKey: false, update: null });
  const labels = labelsOf(items);
  assert.ok(labels.includes("⌥Space is used by another app") && labels.includes("⌥⇧Space is used by another app"));
  const login = items.find((i) => i.kind === "checkbox")!;
  assert.equal(login.checked, true);
  assert.deepEqual(login.action, { type: "login", checked: false });
});

const respond = (status: number, chunks: string[]): PresentFetch => async () => ({ status, body: new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } }) });

test("a read gives a JSON object or nothing: a status, a size cap, an array and bad JSON are all nothing", async () => {
  assert.deepEqual(await getJsonObject(respond(200, ['{"a":', "1}"]), "https://x/api/now"), { a: 1 });
  for (const f of [respond(200, ["[]"]), respond(200, ["null"]), respond(200, ["{bad"]), respond(302, ["{}"]), respond(503, ["{}"]), respond(200, ["\xff\xfe"])]) assert.equal(await getJsonObject(f, "https://x/"), null);
  assert.equal(await getJsonObject(respond(200, ['{"a":"' + "x".repeat(3000) + '"}']), "https://x/", 1000, 2000), null);
  assert.equal(await getJsonObject(async () => { throw new Error("timeout"); }, "https://x/"), null);
  let seen: { redirect: string; timed: boolean } | null = null;
  await getJsonObject(async (_u, init) => { seen = { redirect: init.redirect, timed: init.signal instanceof AbortSignal }; return { status: 200, body: null }; }, "https://x/");
  assert.deepEqual(seen, { redirect: "manual", timed: true });
});

test("combining marks are capped after each character, so zalgo text cannot spill", () => {
  const marks = "̀́̂̃̄̅̆";
  const zalgo = "H" + marks.repeat(20) + "i";
  assert.equal(clean(zalgo, 50), "H̀́i");
  assert.equal(clean("é", 5), "é");   // NFC composes it
  assert.equal(clean("q̀́̂q̀́̂", 10), "q̀́q̀́");
  assert.equal(notesToText(zalgo), "H̀́i");
});

test("an event id must be a safe, non-negative integer", () => {
  const m = parseNow({ owners: [], events: [{ id: 2 ** 60, kind: "deploy", failed: true }, { id: -1, kind: "deploy", failed: true }, { id: 1.5, kind: "deploy", failed: true }, { id: 4, kind: "deploy", failed: true }] }, me)!;
  assert.deepEqual(m.deploys.map((d) => d.id), [4]);
});

test("a console whose database was replaced: the lower newest id is the new baseline, and nothing is said of it", () => {
  const dep = (id: number) => ({ id, failed: true, subject: "app", summary: "x" });
  let r = decide(freshMemory(), model({ deploys: [dep(500)] }));
  r = decide(r.next, model({ deploys: [dep(3)] }));            // 3 < 500: replaced
  assert.deepEqual(r.items, []);
  assert.equal(r.next.maxEvent, 3);
  r = decide(r.next, model({ deploys: [dep(4), dep(3)] }));    // and a real new failure after that is news again
  assert.deepEqual(r.items.map((i) => i.title), ["A deploy failed"]);
  r = decide(r.next, model({ deploys: [] }));                  // no events at all: the baseline stands
  assert.equal(r.next.maxEvent, 4);
});

test("a name the menu lists is one its click can open: '..' is refused in the name", () => {
  assert.equal(workspaceRoute("alice", "a..b"), null);
  assert.equal(plainName("a..b"), null);
  assert.equal(plainName("a.b"), "a.b");
  const m = parseNow({ owners: [], machines: { x: { state: { workspaces: [{ name: "a..b", owner: "alice", status: "running" }, { name: "ok.name", owner: "alice", status: "running" }] } } } }, me)!;
  assert.deepEqual(m.workspaces.map((w) => w.name), ["ok.name"]);
  const items = buildMenu({ inOerba: true, now: m, loginItem: false, paletteKey: true, chatKey: true, update: null });
  for (const w of m.workspaces) assert.equal(safeRoute(workspaceRoute(w.owner, w.name)), true);
  assert.equal(labelsOf(items).includes("  a..b"), false);
});

test("the palette's opening is a fixed string, with nothing woven into it", () => {
  assert.equal(OPEN_PALETTE_JS.includes("${"), false);
  assert.match(OPEN_PALETTE_JS, /^document\.dispatchEvent\(new KeyboardEvent\("keydown", \{ key: "k", metaKey: true, bubbles: true, cancelable: true \}\)\)$/);
});
