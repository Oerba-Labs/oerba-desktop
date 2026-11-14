/* When a page may send a person to the system browser. Pure: no Electron. Only Oerba's own top frame may, only just after
   the person pressed a key or the mouse in the window, one link for each press, and only a few a minute. A frame inside it
   (a workspace door runs a developer's code) never may, however it asks. */

export type LinkVerdict = "open" | "origin" | "gesture" | "rate";

export class LinkOutGate {
  private gestureAt = Number.NEGATIVE_INFINITY;
  private opened: number[] = [];

  constructor(private readonly max = 5, private readonly perMs = 60_000, private readonly gestureMs = 2_000) {}

  /** A key or mouse press reached the window. */
  noteGesture(now: number): void { this.gestureAt = now; }

  /** Whether one link out may go now. An answer of "open" is counted, and uses up the press that allowed it. */
  decide(fromOerbaTop: boolean, now: number): LinkVerdict {
    if (!fromOerbaTop) return "origin";
    if (now - this.gestureAt > this.gestureMs) return "gesture";
    this.opened = this.opened.filter((t) => now - t < this.perMs);
    if (this.opened.length >= this.max) return "rate";
    this.opened.push(now);
    this.gestureAt = Number.NEGATIVE_INFINITY;
    return "open";
  }
}
