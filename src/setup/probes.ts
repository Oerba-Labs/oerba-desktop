/* The setup screen's checks. Every one only reads: it looks for a file, asks Tailscale for its state, or asks Oerba who
   is asking. The things that touch the system are passed in, so a test stands in for them. */

import type { Probes, TailscaleState } from "./state";
import { readWho, type Who } from "./who";

export const TAILSCALE_APP = "/Applications/Tailscale.app";
export const TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** The one set of arguments ever given to Tailscale: it reports, and changes nothing. */
export const TAILSCALE_ARGS: readonly string[] = ["status", "--json"];

/** Takes the program's standard output, or null where it could not be run or gave nothing. Run without a shell. */
export type RunStatus = (file: string, args: readonly string[]) => Promise<string | null>;

/** Reads only the backend state from `tailscale status --json` and keeps nothing else of it. */
export function parseBackendState(stdout: string | null): TailscaleState {
  if (stdout === null) return "unreadable";
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return "unreadable"; }
  if (typeof parsed !== "object" || parsed === null) return "unreadable";
  const state = (parsed as Record<string, unknown>)["BackendState"];
  if (typeof state !== "string") return "unreadable";
  if (state === "Running") return "running";
  if (state === "NeedsLogin") return "needs-login";
  if (state === "Stopped") return "stopped";
  return "other";
}

export async function probeTailscaleState(run: RunStatus): Promise<TailscaleState> {
  let out: string | null = null;
  try { out = await run(TAILSCALE_CLI, TAILSCALE_ARGS); } catch { out = null; }
  return parseBackendState(out);
}

const MAX_BODY = 100_000;

export interface OerbaAnswer { answered: boolean; who: Who | null }
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

/** Oerba answers when /api/who returns 200 and a JSON object. Anything else (no route, a timeout, a refusal) is no answer. */
export async function probeOerba(fetchFn: FetchLike, origin: string, timeoutMs = 6000): Promise<OerbaAnswer> {
  try {
    const res = await fetchFn(`${origin}/api/who`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { accept: "application/json" } });
    if (res.status !== 200) return { answered: false, who: null };
    const text = await res.text();
    if (text.length > MAX_BODY) return { answered: false, who: null };
    const who = readWho(JSON.parse(text));
    return who === null ? { answered: false, who: null } : { answered: true, who };
  } catch {
    return { answered: false, who: null };
  }
}

export interface ProbeDeps {
  exists: (path: string) => boolean;
  run: RunStatus;
  fetchFn: FetchLike;
  oerbaOrigin: string;
  timeoutMs?: number;
}

export async function probeAll(d: ProbeDeps): Promise<Probes> {
  const tailscaleInstalled = d.exists(TAILSCALE_APP);
  const [tailscale, oerba] = await Promise.all([
    tailscaleInstalled ? probeTailscaleState(d.run) : Promise.resolve<TailscaleState>("unreadable"),
    probeOerba(d.fetchFn, d.oerbaOrigin, d.timeoutMs),
  ]);
  return { tailscaleInstalled, tailscale, oerba };
}
