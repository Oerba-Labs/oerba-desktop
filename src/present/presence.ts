/* The app's presence outside its window: the menu bar item, notifications, the dock badge and two global shortcuts.
   It reads /api/now and /api/who and presses nothing: every menu item and every click on a notification only opens the
   window at a route. Every word from a machine passes through src/present/text.ts before it reaches a native surface. */

import { app, globalShortcut, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { readWho } from "../setup/who";
import { buildMenu, labelsOf, type Action, type MenuItem } from "./menu";
import { getJsonObject, type PresentFetch } from "./fetch";
import { badgeText, decide, freshMemory, Limiter, type Item, type Memory } from "./notify";
import { parseNow, type NowModel } from "./now";
import type { RelayManager } from "../relay/manager";

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
  /** The person is in: the updater may start asking. */
  onIn(): void;
  quit(): void;
  /** The localhost forwards (src/relay/): started from the menu, stopped with their workspace. */
  relay: RelayManager;
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
  private update: string | null = null;

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
  }

  /** An update is waiting (its version, already checked to be plain), or none. */
  setUpdate(version: string | null): void { this.update = version; this.render(); }

  labels(): string[] { return labelsOf(this.menu); }

  private toNative(m: MenuItem): MenuItemConstructorOptions {
    if (m.kind === "separator") return { type: "separator" };
    const o: MenuItemConstructorOptions = { label: m.label, enabled: m.enabled !== false };
    if (m.kind === "checkbox") { o.type = "checkbox"; o.checked = m.checked === true; }
    if (m.submenu) o.submenu = m.submenu.map((s) => this.toNative(s));
    const action = m.action;
    if (action) o.click = (item) => this.act(action, item.checked);
    return o;
  }

  /** The relay's list changed (a forward started, stopped or ended with its workspace): the menu is drawn again. */
  redraw(): void { this.render(); }

  private act(a: Action, checked: boolean): void {
    if (a.type === "open") this.d.show();
    else if (a.type === "route") this.d.openRoute(a.route);
    else if (a.type === "palette") this.d.palette();
    else if (a.type === "update") this.d.openUpdate();
    else if (a.type === "forward") void this.d.relay.start(a.owner, a.name, a.port).then(() => this.render());
    else if (a.type === "stop") void this.d.relay.stop(a.id).then(() => this.render());
    else if (a.type === "login") app.setLoginItemSettings({ openAtLogin: checked });   // only when the person ticks it
    else this.d.quit();
  }
}
