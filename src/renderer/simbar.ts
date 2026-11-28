/* The dev panel's bar: the device button (it asks the main process for the device picker, which the main process makes from
   simctl's own list; no device is named from here), the workspace and app it shows, what the panel is doing, and Close. Every word
   from the main process is set with textContent. */

interface BarState { device: string; app: string; status: string }
interface Bridge {
  getState(): Promise<unknown>;
  onState(cb: (state: unknown) => void): void;
  act(action: "devices" | "close"): Promise<void>;
}

const bridge = (window as unknown as { oerbaSimbar?: Bridge }).oerbaSimbar;
const el = (id: string): HTMLElement => document.getElementById(id)!;

function draw(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const s = raw as Partial<BarState>;
  if (typeof s.device === "string") el("name").textContent = s.device.slice(0, 60);
  el("app").textContent = typeof s.app === "string" ? s.app.slice(0, 80) : "";
  const status = typeof s.status === "string" ? s.status.slice(0, 120) : "";
  el("status").textContent = status;
  document.querySelector("header")?.classList.toggle("busy", status !== "");
}

if (bridge) {
  bridge.onState(draw);
  void bridge.getState().then(draw);
  el("device").addEventListener("click", () => { void bridge.act("devices"); });
  el("close").addEventListener("click", () => { void bridge.act("close"); });
}
