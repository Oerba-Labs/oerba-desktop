/* What is worth a notification, and how many are let through. Pure. Quiet on success: nothing is said for a deploy that
   went well, a workspace that started, or something that was already waiting when the app started. */

import type { NowModel } from "./now";
import { HOME, workspaceRoute } from "./routes";

export interface Item { title: string; body: string; route: string }

export interface Memory {
  /** False until the first read has been learnt as the baseline. */
  primed: boolean;
  needs: Set<string>;
  maxEvent: number;
  status: Map<string, string>;
}

export const freshMemory = (): Memory => ({ primed: false, needs: new Set(), maxEvent: 0, status: new Map() });

const FAILED = "failed";

/** The notifications this read earns, and what to remember for the next. The first read earns none. */
export function decide(mem: Memory, now: NowModel): { next: Memory; items: Item[] } {
  const next: Memory = {
    primed: true,
    needs: new Set(now.needs.map((n) => n.key)),
    maxEvent: Math.max(mem.maxEvent, ...now.deploys.map((d) => d.id), 0),
    status: new Map(now.workspaces.map((w) => [`${w.owner}/${w.name}`, w.status])),
  };
  if (!mem.primed) return { next, items: [] };

  const items: Item[] = [];
  for (const n of now.needs) {
    if (!mem.needs.has(n.key)) items.push({ title: "Waiting on you", body: n.title, route: HOME });
  }
  for (const d of now.deploys) {
    if (d.id > mem.maxEvent && d.failed) items.push({ title: "A deploy failed", body: [d.subject, d.summary].filter(Boolean).join(": "), route: HOME });
  }
  for (const w of now.workspaces) {
    if (w.status === FAILED && mem.status.get(`${w.owner}/${w.name}`) !== FAILED) {
      items.push({ title: "A workspace failed", body: w.name, route: workspaceRoute(w.owner, w.name) ?? HOME });
    }
  }
  return { next, items };
}

/** The number on the dock: what waits on the owner, nothing for anyone else, and nothing at zero. */
export function badgeText(now: NowModel | null): string {
  if (now === null || !now.isOwner || now.needs.length === 0) return "";
  return now.needs.length > 99 ? "99+" : String(now.needs.length);
}

/** At most `max` notifications a `perMs`; those beyond are folded into one "and n more", and those that find no room at
    all are owed to the next that has some. */
export class Limiter {
  private sent: number[] = [];
  private owed = 0;

  constructor(private readonly max = 5, private readonly perMs = 60_000) {}

  admit(items: Item[], now: number): Item[] {
    this.sent = this.sent.filter((t) => now - t < this.perMs);
    const room = this.max - this.sent.length;
    if (room <= 0) { this.owed += items.length; return []; }

    let shown = items;
    let extra = this.owed;
    if (items.length + (extra > 0 ? 1 : 0) > room) {
      shown = items.slice(0, room - 1);
      extra += items.length - shown.length;
    }
    this.owed = 0;
    const out = [...shown];
    if (extra > 0) out.push({ title: "Oerba", body: `and ${extra} more`, route: HOME });
    for (let i = 0; i < out.length; i++) this.sent.push(now);
    return out;
  }
}
