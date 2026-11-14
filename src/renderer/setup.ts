/* The setup screen. Every word that came from the main process is set with textContent, never innerHTML. */

interface Step { id: string; title: string; status: "done" | "next" | "waiting" | "ask"; hint: string; action?: string }
interface State { steps: Step[]; ready: boolean; note: string }
interface Bridge {
  getState(): Promise<unknown>;
  onState(cb: (s: unknown) => void): void;
  act(a: "open-tailscale-download" | "recheck"): Promise<void>;
}

const bridge = (window as unknown as { oerbaSetup?: Bridge }).oerbaSetup;
const list = document.getElementById("steps") as HTMLOListElement;
const note = document.getElementById("note") as HTMLParagraphElement;
const again = document.getElementById("again") as HTMLButtonElement;

const MARK: Record<Step["status"], string> = { done: "✓", next: "→", waiting: "·", ask: "?" };

function isState(v: unknown): v is State {
  return typeof v === "object" && v !== null && Array.isArray((v as State).steps);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function draw(state: State): void {
  list.replaceChildren();
  for (const s of state.steps) {
    const li = node("li", `step ${s.status}`);
    li.append(node("span", "mark", MARK[s.status]));
    const body = node("div", "body");
    body.append(node("div", "title", s.title));
    if (s.hint) body.append(node("div", "hint", s.hint));
    if (s.action === "open-tailscale-download" && bridge) {
      const b = node("button", "primary", "Get Tailscale");
      b.type = "button";
      b.addEventListener("click", () => { void bridge.act("open-tailscale-download"); });
      body.append(b);
    }
    li.append(body);
    list.append(li);
  }
  note.textContent = state.note;
  note.hidden = state.note === "";
}

if (!bridge) {
  note.textContent = "This screen can only run inside Oerba Desktop.";
  note.hidden = false;
} else {
  bridge.onState((s) => { if (isState(s)) draw(s); });
  void bridge.getState().then((s) => { if (isState(s)) draw(s); });
  again.addEventListener("click", () => { void bridge.act("recheck"); });
}
