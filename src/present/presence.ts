/* The app's presence outside its window: the menu bar item, notifications, the dock badge and two global shortcuts.
   It reads /api/now and /api/who and presses nothing of Oerba's: a menu item or a click on a notification opens the window at a
   route, or does something of this app's own on this Mac (a forward, the simulator, Restart to Update, Quit). Every word from a machine passes through src/present/text.ts before it reaches a native surface. */

import { app, globalShortcut, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { readWho } from "../setup/who";
import { buildMenu, labelsOf, type Action, type MenuItem } from "./menu";
import { getJsonObject, type PresentFetch } from "./fetch";
import { badgeText, decide, freshMemory, Limiter, type Item, type Memory } from "./notify";
import { approvedOpen, localAddress, NOTIFY_PORTS, WEB_PORTS } from "../policy/browser";
import { workspaceRoute } from "./routes";
import { clean } from "./text";
import { parseNow, type NowModel } from "./now";
import type { RelayManager } from "../relay/manager";
import { describe, expoHint, METRO_PORTS } from "../sim/decide";
import { OnePress, openInSimulator, simulator } from "../sim/run";

export interface Deps {
  oerbaOrigin: string;
  fetchFn: PresentFetch;
  /** Overrides both intervals; the self-test's alone. */
  intervalMs: number | null;
  windowShown(): boolean;
  show(): void;
  openRoute(route: string): void;
  palette(): void;
  openUpdate(): void;
  /** Restarts into a downloaded update (the menu's Restart to Update). */
  restartForUpdate(): void;
  /** The person is in: the updater may start asking. */
  onIn(): void;
  quit(): void;
  /** The localhost forwards (src/relay/): started from the menu, stopped with their workspace. */
  relay: RelayManager;
  /** Opens an address in the system browser. Called only with one policy/browser.ts approved. */
  openLocal(address: string): void;
  /** Shows the iPhone panel for a device: absent, the device is shown in Device Hub as before. */
  showPanel?(udid: string, name: string): Promise<void>;
}

/** How a notification is shown. The self-test replaces it with a recorder, and nothing else does. */
export const sink = {
  show(item: Item, onClick: () => void): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: item.title, body: item.body, silent: true });
    live.add(n);
    n.on("click", onClick);
    n.on("close", () => live.delete(n));
    n.show();
  },
};
const live = new Set<Notification>();

export class Presence {
  now: NowModel | null = null;
  inOerba = false;
  private tray: Tray | null = null;
  private mem: Memory = freshMemory();
  private readonly limiter = new Limiter(5, 60_000);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private keys = { palette: false, chat: false };
  menu: MenuItem[] = [];
  dockMenu: MenuItem[] = [];
  private update: { version: string; ready: boolean } | null = null;
  private readonly simPress = new OnePress();
  private hinted = false;

  constructor(private readonly d: Deps) {}

  start(): void {
    const dir = __dirname;
    const icon = nativeImage.createFromPath(path.join(dir, "trayTemplate.png"));
    icon.setTemplateImage(true);   // black with alpha: drawn in white or black to suit the menu bar
    this.tray = new Tray(icon);
    this.tray.setToolTip("Oerba");
    // Each is registered only if it is free; the menu says so when it is not.
    this.keys.palette = globalShortcut.register("Alt+Space", () => this.d.palette());
    this.keys.chat = globalShortcut.register("Alt+Shift+Space", () => this.d.openRoute("#/chat"));
    this.render();
  }

  /** Called once the person is in: only then is Oerba asked anything. */
  setIn(): void {
    if (this.inOerba) return;
    this.inOerba = true;
    this.d.onIn();
    this.render();
    this.running = true;
    void this.cycle();
  }

  /** Called if the person is put back on the setup screen. */
  setOut(): void {
    this.inOerba = false;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.render();
  }

  stop(): void {
    this.setOut();
    globalShortcut.unregisterAll();
    this.tray?.destroy();
    this.tray = null;
  }

  private async cycle(): Promise<void> {
    if (!this.running) return;
    try { await this.refresh(); } catch { /* the next cycle asks again */ }
    if (!this.running) return;
    const wait = this.d.intervalMs ?? (this.d.windowShown() ? 20_000 : 60_000);
    this.timer = setTimeout(() => { void this.cycle(); }, wait);
  }

  /** One read of /api/now (and of who, to know which workspaces are the person's), and what follows from it. */
  async refresh(): Promise<void> {
    const [nowBody, whoBody] = await Promise.all([
      getJsonObject(this.d.fetchFn, `${this.d.oerbaOrigin}/api/now`),
      getJsonObject(this.d.fetchFn, `${this.d.oerbaOrigin}/api/who`),
    ]);
    if (nowBody === null) return;   // no answer: what was last known stands, and nothing is said
    const who = readWho(whoBody);
    const model = parseNow(nowBody, { handle: who?.handle ?? "", github: who?.github ?? "" });
    if (model === null) return;
    const { next, items } = decide(this.mem, model);
    this.mem = next;
    this.now = model;
    await this.d.relay.reconcile(model.workspaces);
    for (const item of this.limiter.admit(items, Date.now())) sink.show(item, () => this.d.openRoute(item.route));
    app.dock?.setBadge(badgeText(model));
    this.render();
  }

  private render(): void {
    this.menu = buildMenu({ inOerba: this.inOerba, now: this.now, loginItem: app.getLoginItemSettings().openAtLogin, paletteKey: this.keys.palette, chatKey: this.keys.chat, update: this.update, forwards: this.d.relay.list() });
    this.tray?.setContextMenu(Menu.buildFromTemplate(this.menu.map((m) => this.toNative(m))));
    // The Dock icon carries the same pieces of the same menu (so a notch cannot hide them): open, workspaces with their forwards, new chat.
    // The Dock has its own Quit.
    const dockLabels = new Set(["Open Oerba", "Workspaces", "New chat"]);
    this.dockMenu = this.menu.filter((m) => dockLabels.has(m.label));
    app.dock?.setMenu(Menu.buildFromTemplate(this.dockMenu.map((m) => this.toNative(m))));
  }

  /** An update found (its version, already checked to be plain), and whether it is ready, or none. */
  setUpdate(u: { version: string; ready: boolean } | null): void { this.update = u; this.render(); }

  /** Says once, when an update has downloaded, that it is ready; a click opens the update window. */
  updateReady(version: string): void {
    sink.show({ title: `Oerba ${version} is ready`, body: "Restart to update now, or Oerba restarts itself when you are away, a day from now.", route: "" }, () => this.d.openUpdate());
  }

  labels(): string[] { return labelsOf(this.menu); }
  dockLabels(): string[] { return labelsOf(this.dockMenu); }

  private toNative(m: MenuItem): MenuItemConstructorOptions {
    if (m.kind === "separator") return { type: "separator" };
    const o: MenuItemConstructorOptions = { label: m.label, enabled: m.enabled !== false };
    if (m.kind === "checkbox") { o.type = "checkbox"; o.checked = m.checked === true; }
    if (m.submenu) o.submenu = m.submenu.map((s) => this.toNative(s));
    const action = m.action;
    if (action) o.click = (item) => this.act(action, item.checked);
    return o;
  }

  /** The press that starts a forward: a web port then opens the browser at the number it took, Metro's and Expo's say where it is,
      and a failure says why in a few words. Only a press that really started it does either; a forward already running opens nothing. */
  async startForward(owner: string, name: string, port: number): Promise<void> {
    const r = await this.d.relay.tryStart(owner, name, port);
    this.render();
    const route = workspaceRoute(owner, name) ?? "#/";
    const say = (title: string, body: string): void => {
      for (const item of this.limiter.admit([{ title, body: clean(body, 120), route }], Date.now())) sink.show(item, () => this.d.openRoute(item.route));
    };
    if ("why" in r) { say("Could not open the port", `${name}'s ${port}: ${r.why}`); return; }
    if (!r.fresh) return;
    const { local, remote } = r.info;
    if (WEB_PORTS.includes(remote)) {
      const url = approvedOpen(localAddress(local), this.d.relay.list());
      if (url !== null) this.d.openLocal(url);
    } else if (NOTIFY_PORTS.includes(remote)) {
      say("Oerba", `localhost:${local}${local === remote ? "" : ` (${remote} was taken)`} → ${name}'s ${remote}`);
    }
  }

  /** The press "Open in iOS Simulator" on a Metro port: starts the forward if it is not running, then runs src/sim/'s sequence at the
      number the forward took, and says in one notification what it did. A press while one is running is ignored. Only the menu calls it. */
  async openInSimulator(owner: string, name: string, port: number): Promise<void> {
    if (!METRO_PORTS.includes(port)) return;
    const route = workspaceRoute(owner, name) ?? "#/";
    const say = (title: string, body: string): void => {
      for (const item of this.limiter.admit([{ title: clean(title, 60), body: clean(body, 200), route }], Date.now())) sink.show(item, () => this.d.openRoute(item.route));
    };
    await this.simPress.run(async () => {
      const f = await this.d.relay.tryStart(owner, name, port);
      this.render();
      if ("why" in f) { say("Could not open the port", `${name}'s ${port}: ${f.why}`); return; }
      const panelled = this.d.showPanel !== undefined;
      const outcome = await openInSimulator(f.info.local, simulator.run, { window: !panelled });
      if (outcome.kind === "opened" && this.d.showPanel) await this.d.showPanel(outcome.udid, outcome.name);
      const words = describe(outcome);
      say(words.title, words.body);
      if (outcome.kind === "opened" && !this.hinted) {
        this.hinted = true;
        const h = expoHint();
        say(h.title, h.body);
      }
    });
  }

  /** The relay's list changed (a forward started, stopped or ended with its workspace): the menu is drawn again. */
  redraw(): void { this.render(); }

  private act(a: Action, checked: boolean): void {
    if (a.type === "open") this.d.show();
    else if (a.type === "route") this.d.openRoute(a.route);
    else if (a.type === "palette") this.d.palette();
    else if (a.type === "update") this.d.openUpdate();
    else if (a.type === "restart") this.d.restartForUpdate();
    else if (a.type === "forward") void this.startForward(a.owner, a.name, a.port);
    else if (a.type === "simulator") void this.openInSimulator(a.owner, a.name, a.port);
    else if (a.type === "stop") void this.d.relay.stop(a.id).then(() => this.render());
    else if (a.type === "login") app.setLoginItemSettings({ openAtLogin: checked });   // only when the person ticks it
    else this.d.quit();
  }
}
