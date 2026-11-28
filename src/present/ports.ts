/* Which ports a workspace is listening on, as On-Demand's agent in it reports them, in place of the fixed list of usual ports; and
   when Metro starting is worth an offer to open the app on a device. Read as the person, with no credential: On-Demand knows them
   by their tailnet address through the lab's front door, as the forwards reach it (src/relay/rules.ts), and the same GET as
   /api/now's is used (a timeout, no redirects, a size cap, a JSON object or nothing). Only the person's own started workspaces are
   asked about, and only their numbers are kept: a process's name, or anything else On-Demand says, is not. */

import { getJsonObject, type PresentFetch } from "./fetch";
import { AGENT, UPSTREAM_SUFFIX, upstreamName } from "../relay/rules";
import { isUdid, METRO_PORTS } from "../sim/decide";

/** On-Demand's own address, the name its ports' doors sit under. */
export const ONDEMAND_API = `https://${UPSTREAM_SUFFIX.slice(1)}`;

/** The most ports kept for one workspace. */
export const MAX_PORTS = 32;

/** Databases' usual ports (MySQL, Postgres, Redis, MongoDB): the forwards carry HTTP and websockets alone, so these are not offered. */
export const NOT_HTTP: readonly number[] = [3306, 5432, 6379, 27017];

/** The address of a workspace's own record, or null for a name not of On-Demand's shape (the forwards' own check). */
export function workspaceUrl(api: string, owner: string, name: string): string | null {
  if (upstreamName(8081, name, owner) === null) return null;
  return `${api}/api/v2/users/${encodeURIComponent(owner.toLowerCase())}/workspace/${encodeURIComponent(name.toLowerCase())}`;
}

/** The id of the workspace's agent named as the forwards dial it (`main`), from its latest build's resources; null if there is none
    or it is not UUID-shaped, so that nothing else is put in the next address. */
export function agentId(body: Record<string, unknown> | null): string | null {
  const build = body?.["latest_build"];
  const resources = typeof build === "object" && build !== null ? (build as { resources?: unknown }).resources : null;
  if (!Array.isArray(resources)) return null;
  for (const r of resources) {
    const agents = typeof r === "object" && r !== null ? (r as { agents?: unknown }).agents : null;
    if (!Array.isArray(agents)) continue;
    for (const a of agents) {
      const o = typeof a === "object" && a !== null ? (a as Record<string, unknown>) : null;
      if (o?.["name"] === AGENT && isUdid(o["id"])) return o["id"];
    }
  }
  return null;
}

/** The TCP ports of On-Demand's answer that a forward could dial (1024 to 65535) and carry (not a database's), each once, in order;
    null for an answer that is not the shape. */
export function parsePorts(body: Record<string, unknown> | null): number[] | null {
  const list = body?.["ports"];
  if (!Array.isArray(list)) return null;
  const out = new Set<number>();
  for (const p of list) {
    const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
    const n = o?.["port"];
    if (o?.["network"] !== "tcp" || typeof n !== "number" || !Number.isInteger(n) || n < 1024 || n > 65535 || NOT_HTTP.includes(n)) continue;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b).slice(0, MAX_PORTS);
}

export type PortsReader = (owner: string, name: string) => Promise<number[] | null>;

/** Reads one workspace's listening ports from On-Demand: its record for the agent's id, then the agent's ports. Null when either
    does not answer as expected (a stopped workspace, an agent not yet connected, On-Demand not reached). */
export function onDemandPorts(fetchFn: PresentFetch, api: string = ONDEMAND_API): PortsReader {
  return async (owner, name) => {
    const url = workspaceUrl(api, owner, name);
    if (url === null) return null;
    const id = agentId(await getJsonObject(fetchFn, url));
    if (id === null) return null;
    return parsePorts(await getJsonObject(fetchFn, `${api}/api/v2/workspaceagents/${id}/listening-ports`));
  };
}

export interface Reading { owner: string; name: string; ports: number[] | null }
export interface Offer { owner: string; name: string; port: number }
export interface PortMemory { primed: boolean; metro: Map<string, Set<number>> }

export const freshPortMemory = (): PortMemory => ({ primed: false, metro: new Map() });

/** The least time between two offers for one workspace: Metro restarting, or a workspace's code opening and closing the port, is
    not an offer each time. */
export const OFFER_COOLDOWN_MS = 5 * 60_000;

/** The offers that may be made now: one a workspace, and none for a workspace offered within the cooldown. `last` is when each
    workspace was last offered, by wsKey, and is brought up to date; entries older than the cooldown are let go. */
export function admitOffers(offers: readonly Offer[], last: Map<string, number>, now: number, coolMs = OFFER_COOLDOWN_MS): Offer[] {
  for (const [k, at] of last) if (now - at >= coolMs) last.delete(k);
  const out: Offer[] = [];
  for (const o of offers) {
    const k = wsKey(o.owner, o.name);
    if (last.has(k)) continue;
    last.set(k, now);
    out.push(o);
  }
  return out;
}

/** How a workspace's ports are kept: by owner and name, without regard to case. */
export const wsKey = (owner: string, name: string): string => `${owner.toLowerCase()}/${name.toLowerCase()}`;

/** The offers this reading earns: a Metro port listening now that was not at the last reading of its workspace (a workspace not
    read last time, or stopped since, had none). The first reading after the app starts is the baseline and earns none, as a
    notification never says what was already so. A workspace whose ports could not be read keeps what was known. `skip` leaves
    out what the dev panel is showing already. */
export function metroOffers(mem: PortMemory, readings: readonly Reading[], skip: (o: Offer) => boolean = () => false): { next: PortMemory; offers: Offer[] } {
  const next: PortMemory = { primed: true, metro: new Map() };
  const offers: Offer[] = [];
  for (const r of readings) {
    const k = wsKey(r.owner, r.name);
    const before = mem.metro.get(k);
    if (r.ports === null) { if (before) next.metro.set(k, before); continue; }
    const now = new Set(r.ports.filter((p) => METRO_PORTS.includes(p)));
    next.metro.set(k, now);
    if (!mem.primed) continue;
    for (const port of now) {
      const o = { owner: r.owner, name: r.name, port };
      if (!before?.has(port) && !skip(o)) offers.push(o);
    }
  }
  return { next, offers };
}
