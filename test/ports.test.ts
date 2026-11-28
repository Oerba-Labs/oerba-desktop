import { test } from "node:test";
import assert from "node:assert/strict";
import { agentId, freshPortMemory, MAX_PORTS, metroOffers, ONDEMAND_API, onDemandPorts, parsePorts, workspaceUrl, type Reading } from "../src/present/ports";
import type { PresentFetch } from "../src/present/fetch";
import { buildMenu, labelsOf } from "../src/present/menu";
import type { NowModel } from "../src/present/now";

const AGENT_ID = "0c2f5d1a-7e4b-4f3a-9d6e-2b8c1f0a9e77";

test("On-Demand is asked at its own name, about a workspace of the forwards' shape alone", () => {
  assert.equal(ONDEMAND_API, "https://ondemand.oerba.dev");
  assert.equal(workspaceUrl(ONDEMAND_API, "Alice", "Demo"), "https://ondemand.oerba.dev/api/v2/users/alice/workspace/demo");
  for (const [o, n] of [["alice@github", "demo"], ["alice", "a.b"], ["alice", "../x"], ["al ice", "demo"], ["alice", "x?y"]]) assert.equal(workspaceUrl(ONDEMAND_API, o!, n!), null, `${o}/${n}`);
});

test("the agent is the one the forwards dial, `main`, and its id must be UUID-shaped", () => {
  const build = (agents: unknown[]) => ({ latest_build: { resources: [{ agents: null }, { agents }] } });
  assert.equal(agentId(build([{ name: "other", id: AGENT_ID }, { name: "main", id: AGENT_ID }])), AGENT_ID);
  assert.equal(agentId(build([{ name: "main", id: "../../users/me" }])), null);
  assert.equal(agentId(build([{ name: "other", id: AGENT_ID }])), null);
  for (const junk of [null, {}, { latest_build: null }, { latest_build: { resources: {} } }]) assert.equal(agentId(junk as Record<string, unknown> | null), null);
});

test("only TCP ports a forward could dial and carry are kept, each once, in order, and no more than MAX_PORTS", () => {
  const body = { ports: [{ port: 8081, network: "tcp", process_name: "node" }, { port: 22, network: "tcp" }, { port: 3000, network: "udp" }, { port: 5173, network: "tcp" }, { port: 8081, network: "tcp" }, { port: 70000, network: "tcp" }, { port: "9000", network: "tcp" }, { port: 5432, network: "tcp" }, { port: 6379, network: "tcp" }, null] };
  assert.deepEqual(parsePorts(body), [5173, 8081], "a database's port is not offered: the forwards carry HTTP alone");
  assert.deepEqual(parsePorts({ ports: [] }), []);
  assert.equal(parsePorts({}), null);
  assert.equal(parsePorts(null), null);
  assert.equal(parsePorts({ ports: Array.from({ length: 100 }, (_, i) => ({ port: 2000 + i, network: "tcp" })) })!.length, MAX_PORTS);
});

test("the reader asks for the workspace, then its agent's ports, and says null when either does not answer", async () => {
  const asked: string[] = [];
  const answers = new Map<string, unknown>([
    ["https://od.test/api/v2/users/alice/workspace/demo", { latest_build: { resources: [{ agents: [{ name: "main", id: AGENT_ID }] }] } }],
    [`https://od.test/api/v2/workspaceagents/${AGENT_ID}/listening-ports`, { ports: [{ port: 8081, network: "tcp" }] }],
  ]);
  const fetchFn: PresentFetch = async (url, init) => {
    asked.push(url);
    assert.equal(init.redirect, "manual");
    const body = answers.get(url);
    if (body === undefined) return { status: 404, body: null };
    return { status: 200, body: new Response(JSON.stringify(body)).body };
  };
  const read = onDemandPorts(fetchFn, "https://od.test");
  assert.deepEqual(await read("alice", "demo"), [8081]);
  assert.deepEqual(asked, ["https://od.test/api/v2/users/alice/workspace/demo", `https://od.test/api/v2/workspaceagents/${AGENT_ID}/listening-ports`]);
  assert.equal(await read("alice", "stopped"), null);
  asked.length = 0;
  assert.equal(await read("alice", "a.b"), null);
  assert.deepEqual(asked, [], "a name not of the shape asks nothing");
});

test("an offer is earned when Metro starts listening, never on the first read, once, and not for what the panel shows", () => {
  const r = (ports: number[] | null, name = "demo"): Reading => ({ owner: "alice", name, ports });
  let m = metroOffers(freshPortMemory(), [r([8081])]);
  assert.deepEqual(m.offers, [], "the first read after the app starts is the baseline");
  m = metroOffers(freshPortMemory(), [r([3000])]);
  m = metroOffers(m.next, [r([3000, 8081])]);
  assert.deepEqual(m.offers, [{ owner: "alice", name: "demo", port: 8081 }]);
  m = metroOffers(m.next, [r([3000, 8081])]);
  assert.deepEqual(m.offers, [], "a port still listening is not offered again");
  m = metroOffers(m.next, [r(null)]);
  m = metroOffers(m.next, [r([8081])]);
  assert.deepEqual(m.offers, [], "a read that failed keeps what was known");
  m = metroOffers(m.next, []);
  m = metroOffers(m.next, [r([8081])]);
  assert.deepEqual(m.offers, [{ owner: "alice", name: "demo", port: 8081 }], "a workspace that stopped and started again is offered again");
  m = metroOffers(m.next, [r([]), r([], "web")]);
  m = metroOffers(m.next, [r([8081, 19000]), r([5173], "web")], (o) => o.port === 8081);
  assert.deepEqual(m.offers, [{ owner: "alice", name: "demo", port: 19000 }], "only Metro's ports, and not what the panel shows");
});

test("the menu offers the ports a workspace listens on when On-Demand has said, and the usual ones otherwise", () => {
  const now: NowModel = { isOwner: false, workspaces: [{ owner: "alice", name: "demo", status: "running" }, { owner: "alice", name: "web", status: "running" }], needs: [], deploys: [] };
  const labels = labelsOf(buildMenu({ inOerba: true, now, loginItem: false, paletteKey: true, chatKey: true, update: null, listening: new Map([["alice/demo", [4000, 8081]]]) }));
  const demo = labels.slice(labels.indexOf("  demo"), labels.indexOf("  web"));
  assert.deepEqual(demo, ["  demo", "    Open in Oerba", "    Open on localhost:4000", "    Open on localhost:8081", "    Open 8081 in iOS Simulator"]);
  assert.ok(labels.includes("    Open on localhost:5173") && labels.includes("    Open 19000 in iOS Simulator"), "a workspace not read is offered the usual ports");
  const quiet = labelsOf(buildMenu({ inOerba: true, now, loginItem: false, paletteKey: true, chatKey: true, update: null, listening: new Map([["alice/demo", []]]) }));
  assert.deepEqual(quiet.slice(quiet.indexOf("  demo"), quiet.indexOf("  web")), ["  demo", "    Open in Oerba"], "nothing listening, nothing offered");
});
