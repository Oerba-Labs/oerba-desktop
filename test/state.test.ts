import { test } from "node:test";
import assert from "node:assert/strict";
import { checkingSetup, computeSetup, type Probes } from "../src/setup/state";
import { readWho } from "../src/setup/who";

const who = (o: object) => readWho(o);
const probes = (o: Partial<Probes>): Probes => ({ tailscaleInstalled: true, tailscale: "running", oerba: { answered: false, who: null }, ...o });
const status = (p: Probes) => computeSetup(p).steps.map((s) => `${s.id}:${s.status}`).join(" ");

test("nothing installed: the first step is next, with the download, and nothing is ready", () => {
  const s = computeSetup(probes({ tailscaleInstalled: false, tailscale: "unreadable" }));
  assert.equal(s.ready, false);
  assert.equal(status(probes({ tailscaleInstalled: false, tailscale: "unreadable" })), "installed:next signed-in:waiting invited:waiting name:waiting access:waiting");
  assert.equal(s.steps[0]?.action, "open-tailscale-download");
  assert.equal(s.note, "");
});

test("installed but not signed in: the second step is next, and it only asks", () => {
  for (const t of ["needs-login", "stopped", "other"] as const) {
    const p = probes({ tailscale: t });
    assert.equal(status(p), "installed:done signed-in:next invited:waiting name:waiting access:waiting", t);
    assert.equal(computeSetup(p).steps[1]?.action, undefined);
  }
});

test("signed in but not invited: the third step is next and says whom to ask", () => {
  const s = computeSetup(probes({}));
  assert.equal(status(probes({})), "installed:done signed-in:done invited:next name:waiting access:waiting");
  assert.match(s.steps[2]?.hint ?? "", /Ask whoever sent you the app/);
  assert.equal(s.ready, false);
});

test("Tailscale unreadable: sign-in is judged by Oerba's answer, and the screen says so", () => {
  const no = computeSetup(probes({ tailscale: "unreadable" }));
  assert.match(no.note, /could not read Tailscale/);
  assert.equal(no.steps[1]?.status, "next");
  const yes = computeSetup(probes({ tailscale: "unreadable", oerba: { answered: true, who: who({ handle: "", person: "nobody" }) } }));
  assert.match(yes.note, /could not read Tailscale/);
  assert.equal(yes.steps[1]?.status, "done");
});

test("Oerba answers: ready, steps 1 to 3 ticked, and the name and access shown as what Oerba will ask", () => {
  const p = probes({ oerba: { answered: true, who: who({ handle: "", person: "nobody", may_act: false, known: true }) } });
  const s = computeSetup(p);
  assert.equal(s.ready, true);
  assert.equal(status(p), "installed:done signed-in:done invited:done name:ask access:ask");
});

test("a person with a name and not yet approved: the name is ticked, access still asked", () => {
  const p = probes({ oerba: { answered: true, who: who({ handle: "ada", person: "nobody", may_act: false }) } });
  assert.equal(status(p), "installed:done signed-in:done invited:done name:done access:ask");
});

test("a person with a name and approved is all ticked, whichever way Oerba says it", () => {
  for (const extra of [{ may_act: true }, { person: "member" }, { person: "given" }, { person: "owner" }]) {
    const p = probes({ oerba: { answered: true, who: who({ handle: "ada", ...extra }) } });
    assert.equal(status(p), "installed:done signed-in:done invited:done name:done access:done", JSON.stringify(extra));
  }
});

test("an answer Oerba gave that says nothing of the person still lets them in", () => {
  const p = probes({ oerba: { answered: true, who: null } });
  assert.equal(computeSetup(p).ready, true);
  assert.equal(status(p), "installed:done signed-in:done invited:done name:ask access:ask");
});

test("Oerba answering ticks the Tailscale steps even where the app did not find Tailscale", () => {
  const p = probes({ tailscaleInstalled: false, tailscale: "unreadable", oerba: { answered: true, who: who({ handle: "ada" }) } });
  assert.equal(status(p).startsWith("installed:done signed-in:done invited:done"), true);
});

test("an approval seen on a later look lets them in: the same person, asked again", () => {
  const first = computeSetup(probes({ oerba: { answered: false, who: null } }));
  const later = computeSetup(probes({ oerba: { answered: true, who: who({ handle: "ada", person: "member" }) } }));
  assert.equal(first.ready, false);
  assert.equal(later.ready, true);
});

test("before the first look the list is there, every step waiting, and nothing is ready", () => {
  const s = checkingSetup();
  assert.equal(s.steps.length, 5);
  assert.equal(s.ready, false);
  assert.equal(s.steps.every((x) => x.status === "waiting" && x.hint === "Checking…"), true);
});
