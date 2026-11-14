import { test } from "node:test";
import assert from "node:assert/strict";
import { approved, hasHandle, readWho } from "../src/setup/who";
import { parseBackendState, probeAll, probeOerba, probeTailscaleState, TAILSCALE_ARGS, TAILSCALE_CLI, type FetchLike } from "../src/setup/probes";

// The keys Oerba Desktop reads of GET /api/who, as Oerba's published client contract lists them:
// handle and github, both strings. The answers below are shaped as console/app.py's `who` returns them.
const full = { login: "ada@github", name: "Ada", known: true, may_act: false, admins_set: true, tailnet: "ada@example.com", github: "", handle: "ada", account: "chosen", suggest: "", person: "nobody", orgs: [], personal: true, quota: { access: "nobody" }, vscode: null, connect: { app: "", identify: false } };

test("a reading of /api/who keeps the handle and the hints and nothing else", () => {
  assert.deepEqual(readWho(full), { handle: "ada", github: "", known: true, person: "nobody", mayAct: false });
});

test("a newcomer's answer has no handle; a suggestion is not a name", () => {
  const w = readWho({ ...full, handle: "", account: "", suggest: "ada" });
  assert.ok(w);
  assert.equal(hasHandle(w), false);
  assert.equal(approved(w), false);
});

test("approval: may_act, or an owner, member or given reader; never nobody or suspended", () => {
  assert.equal(approved(readWho({ ...full, may_act: true })!), true);
  for (const person of ["owner", "member", "given"]) assert.equal(approved(readWho({ ...full, person })!), true, person);
  for (const person of ["nobody", "suspended", "unknown", ""]) assert.equal(approved(readWho({ ...full, person })!), false, person);
  assert.equal(approved(readWho({ handle: "ada" })!), false);
});

test("odd bodies are not an answer, odd keys are unknown", () => {
  for (const bad of [null, undefined, 1, "x", [], [{}]]) assert.equal(readWho(bad), null);
  assert.deepEqual(readWho({ handle: 5, github: null, known: "yes", person: 3, may_act: 1 }), { handle: "", github: "", known: null, person: null, mayAct: null });
  assert.equal(readWho({ handle: "  ada  " })?.handle, "ada");
});

const answering = (status: number, body: string): FetchLike => async () => ({ status, text: async () => body });

test("Oerba answers on 200 with a JSON object, and on nothing else", async () => {
  const ok = await probeOerba(answering(200, JSON.stringify(full)), "https://app.oerba.dev");
  assert.equal(ok.answered, true);
  assert.equal(ok.who?.handle, "ada");
  for (const f of [answering(403, "{}"), answering(503, "{}"), answering(302, ""), answering(200, "<html>"), answering(200, "[]"), answering(200, "x".repeat(200_000))]) {
    assert.deepEqual(await probeOerba(f, "https://app.oerba.dev"), { answered: false, who: null });
  }
  const refused: FetchLike = async () => { throw new Error("connect timed out"); };
  assert.deepEqual(await probeOerba(refused, "https://app.oerba.dev"), { answered: false, who: null });
});

test("the question is a plain GET of /api/who with no redirects and a timeout", async () => {
  let seen: { url: string; redirect: string; timed: boolean } | null = null;
  await probeOerba(async (url, init) => { seen = { url, redirect: init.redirect, timed: init.signal instanceof AbortSignal }; return { status: 200, text: async () => "{}" }; }, "https://app.oerba.dev");
  assert.deepEqual(seen, { url: "https://app.oerba.dev/api/who", redirect: "manual", timed: true });
});

test("Tailscale's state is read from the backend state alone", () => {
  assert.equal(parseBackendState(JSON.stringify({ BackendState: "Running", Self: { HostName: "x" } })), "running");
  assert.equal(parseBackendState('{"BackendState":"NeedsLogin"}'), "needs-login");
  assert.equal(parseBackendState('{"BackendState":"Stopped"}'), "stopped");
  assert.equal(parseBackendState('{"BackendState":"Starting"}'), "other");
  for (const bad of [null, "", "not json", "[]", "null", '{"BackendState":3}', "{}"]) assert.equal(parseBackendState(bad), "unreadable", String(bad));
});

test("the app asks Tailscale for its status and nothing that changes it", async () => {
  const calls: [string, readonly string[]][] = [];
  await probeTailscaleState(async (file, args) => { calls.push([file, args]); return '{"BackendState":"Running"}'; });
  assert.deepEqual(calls, [[TAILSCALE_CLI, ["status", "--json"]]]);
  assert.deepEqual([...TAILSCALE_ARGS], ["status", "--json"]);
  for (const forbidden of ["up", "login", "logout", "set", "down", "switch", "serve", "funnel", "ssh", "file"]) assert.equal(TAILSCALE_ARGS.includes(forbidden), false);
  const dead = await probeTailscaleState(async () => { throw new Error("spawn failed"); });
  assert.equal(dead, "unreadable");
});

test("with no Tailscale app, nothing is run", async () => {
  let ran = false;
  const p = await probeAll({ exists: () => false, run: async () => { ran = true; return null; }, fetchFn: answering(503, ""), oerbaOrigin: "https://app.oerba.dev" });
  assert.equal(ran, false);
  assert.equal(p.tailscaleInstalled, false);
  assert.equal(p.oerba.answered, false);
});
