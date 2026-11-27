/* The iPhone panel's bar: the device's name, what the panel is doing, Pop out and Close. Every word from the main process is set
   with textContent. */

interface BarState { name: string; status: string }
interface Bridge {
  getState(): Promise<unknown>;
  onState(cb: (state: unknown) => void): void;
  act(action: "popout" | "close"): Promise<void>;
}

const bridge = (window as unknown as { oerbaSimbar?: Bridge }).oerbaSimbar;
const el = (id: string): HTMLElement => document.getElementById(id)!;

function draw(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const s = raw as Partial<BarState>;
  if (typeof s.name === "string") el("name").textContent = s.name.slice(0, 60);
  el("status").textContent = typeof s.status === "string" ? s.status.slice(0, 120) : "";
}

if (bridge) {
  bridge.onState(draw);
  void bridge.getState().then(draw);
  el("popout").addEventListener("click", () => { void bridge.act("popout"); });
  el("close").addEventListener("click", () => { void bridge.act("close"); });
}
