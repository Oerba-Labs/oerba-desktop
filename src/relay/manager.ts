/* The forwards that are running, one for each (owner, workspace, port). The menu starts and stops them; the poll of /api/now
   stops those whose workspace is no longer started; quitting stops all. */

import { Forward } from "./forward";
import { upstreamName, type Upstream } from "./rules";

export interface ForwardInfo { id: string; owner: string; name: string; remote: number; local: number }
export interface Started { owner: string; name: string; status: string }

/** The ports the menu offers for a workspace: the ones a dev server usually has (web servers, Metro, Expo). */
export const COMMON_PORTS: readonly number[] = [3000, 5173, 8000, 8080, 8081, 19000, 19006];
const MAX_FORWARDS = 16;
const STARTED = /^(running|starting|pending)$/;

export const forwardId = (owner: string, name: string, remote: number): string => `${owner.toLowerCase()}/${name.toLowerCase()}:${remote}`;

export class RelayManager {
  private readonly running = new Map<string, { info: ForwardInfo; fw: Forward }>();
  private readonly starting = new Set<string>();

  constructor(private readonly upstream: Upstream, private readonly changed: () => void = () => undefined) {}

  list(): ForwardInfo[] { return [...this.running.values()].map((r) => r.info); }

  /** Starts a forward of a workspace's port, on the same number here where it is free. Returns it, or null when the
      name is not one a forward may dial, one is already running (it is returned), or no number near was free. */
  async start(owner: string, name: string, remote: number): Promise<ForwardInfo | null> {
    const host = upstreamName(remote, name, owner);
    if (host === null) return null;
    const id = forwardId(owner, name, remote);
    const have = this.running.get(id);
    if (have) return have.info;
    if (this.starting.has(id) || this.running.size + this.starting.size >= MAX_FORWARDS) return null;
    this.starting.add(id);
    try {
      const fw = new Forward({ name: host, port: remote, upstream: this.upstream, forwarded: (n) => [...this.running.values()].some((r) => r.info.local === n) });
      const taken = (n: number): boolean => [...this.running.values()].some((r) => r.info.local === n);
      let local: number;
      try { local = await fw.listen(remote, taken); } catch { await fw.close(); return null; }
      const info: ForwardInfo = { id, owner, name, remote, local };
      this.running.set(id, { info, fw });
      this.changed();
      return info;
    } finally {
      this.starting.delete(id);
    }
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    await r.fw.close();
    this.changed();
  }

  /** Called with each read of /api/now: a forward whose workspace is not among the started ones is stopped. */
  async reconcile(workspaces: readonly Started[]): Promise<void> {
    const live = new Set(workspaces.filter((w) => STARTED.test(w.status)).map((w) => `${w.owner.toLowerCase()}/${w.name.toLowerCase()}`));
    for (const r of [...this.running.values()]) {
      if (!live.has(`${r.info.owner.toLowerCase()}/${r.info.name.toLowerCase()}`)) await this.stop(r.info.id);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}
