/* The update window. Every word that came from outside (the version, the release notes) is set with textContent. */

export {};

interface State { phase: "none" | "available" | "downloading" | "ready" | "failed"; version: string; notes: string; percent: number; problem: string }
interface Bridge {
  getState(): Promise<unknown>;
  onState(cb: (s: unknown) => void): void;
  act(a: "download" | "restart" | "later"): Promise<void>;
}

const bridge = (window as unknown as { oerbaUpdate?: Bridge }).oerbaUpdate;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const title = $("title"), notes = $("notes"), statusEl = $("status"), primary = $<HTMLButtonElement>("primary"), later = $<HTMLButtonElement>("later");

const isState = (v: unknown): v is State => typeof v === "object" && v !== null && typeof (v as State).phase === "string";

function draw(s: State): void {
  title.textContent = s.version ? `Oerba ${s.version} is available` : "No update waiting";
  notes.textContent = s.notes || "No notes were published with this version.";
  primary.hidden = !(s.phase === "available" || s.phase === "failed" || s.phase === "ready");
  primary.disabled = false;
  primary.dataset["do"] = s.phase === "ready" ? "restart" : "download";
  primary.textContent = s.phase === "ready" ? "Restart now" : "Download";
  statusEl.textContent = s.phase === "downloading" ? `Downloading… ${s.percent}%` : s.phase === "ready" ? "Downloaded. It is installed when Oerba next quits; if you have not restarted it a day from now, Oerba restarts itself when you are away." : s.problem;
  later.textContent = s.phase === "ready" ? "Restart later" : "Later";
}

if (!bridge) {
  statusEl.textContent = "This window can only run inside Oerba Desktop.";
} else {
  bridge.onState((s) => { if (isState(s)) draw(s); });
  void bridge.getState().then((s) => { if (isState(s)) draw(s); });
  primary.addEventListener("click", () => { primary.disabled = true; void bridge.act(primary.dataset["do"] === "restart" ? "restart" : "download"); });
  later.addEventListener("click", () => { void bridge.act("later"); });
}
