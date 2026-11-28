/* The app's presence outside its window: the menu bar item, notifications, the dock badge and two global shortcuts.
   It reads /api/now and /api/who and presses nothing of Oerba's: a menu item or a click on a notification opens the window at a
   route, or does something of this app's own on this Mac (a forward, the simulator, Restart to Update, Quit). Every word from a machine passes through src/present/text.ts before it reaches a native surface. */

import { app, globalShortcut, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { readWho } from "../setup/who";
import { buildMenu, labelsOf, type Action, type MenuItem } from "./menu";
import { getJsonObject, type PresentFetch } from "./fetch";
import { badgeText, decide, freshMemory, Limiter, type Item, type Memory } from "./notify";
import { approvedOpen, localAddress, WEB_PORTS } from "../policy/browser";
import { workspaceRoute } from "./routes";
import { clean } from "./text";
import { parseNow, type NowModel } from "./now";
import type { RelayManager } from "../relay/manager";
import { describe, expoHint, METRO_PORTS, pickerGroups, runtimeLabel } from "../sim/decide";
import { listDevices, OnePress, openInSimulator, simulator } from "../sim/run";
import type { DeviceMemory } from "../sim/remember";
import type { PanelContext } from "../sim/panel";
import { admitOffers, freshPortMemory, metroOffers, wsKey, type Offer, type PortsReader, type Reading } from "./ports";

/** What the presence asks of the dev panel (src/sim/panel.ts). */
export interface PanelDeps {
  /** Shows the panel for a device and a workspace's app, the window with it. */
  show(udid: string, name: string, ctx: PanelContext): Promise<void>;
  /** Says in the bar what is happening, or why not; nothing while the panel is closed. */
  say(status: string): void;
  context(): PanelContext | null;
  device(): string | null;
  /** Pops the device picker under the bar's device button. */
  popup(menu: Menu): void;
}

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
  /** The dev panel: absent, a press shows the device in Device Hub as before. */
  panel?: PanelDeps;
  /** Which device each workspace was last opened on (src/sim/remember.ts). */
  memory: DeviceMemory;
  /** Reads a workspace's listening ports from On-Demand (src/present/ports.ts); null reads none, and the menu offers the usual ports. */
  ports: PortsReader | null;
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
  /** The ports each of the person's running workspaces is listening on, as On-Demand last said, by wsKey. */
  listening = new Map<string, number[]>();
  private portMem = freshPortMemory();
  /** When each workspace was last offered, and the offers' own budget: a workspace's code decides when Metro listens, so its offers
      never use the room of the notifications that matter (a deploy that failed, a thing that waits). */
  private offeredAt = new Map<string, number>();
  private readonly offerLimiter = new Limiter(2, 60_000);
  /** How many offers have been made, and the last (the self-test reads them: the notifications' limiter may hold them back, and
      a refresh of the presence's own cycle may be the one that earns it). */
  offerCount = 0;
  lastOffer: Offer | null = null;
  /** The devices the last picker listed, by upper-case UDID: a pick names one of these or nothing happens. */
  private choices = new Map<string, string>();
  /** The listening ports' reader: Deps' own, replaced only by the self-test. */
  ports: PortsReader | null;

  constructor(private readonly d: Deps) { this.ports = d.ports; }

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
    await this.readPorts(model);
    for (const item of this.limiter.admit(items, Date.now())) sink.show(item, () => this.d.openRoute(item.route));
    app.dock?.setBadge(badgeText(model));
    this.render();
  }

  /** Asks On-Demand which ports each of the person's running workspaces is listening on (at most fifteen, all at once), keeps the
      numbers for the menu, and offers to open an app whose Metro has just started on the device last used for it. A workspace
      whose read fails keeps what was known; one no longer running is forgotten. */
  private async readPorts(model: NowModel): Promise<void> {
    const reader = this.ports;
    if (!reader) return;
    const running = model.workspaces.filter((w) => w.status === "running").slice(0, 15);
    const readings: Reading[] = await Promise.all(running.map(async (w) => ({ owner: w.owner, name: w.name, ports: await reader(w.owner, w.name).catch(() => null) })));
    const listening = new Map<string, number[]>();
    for (const r of readings) {
      const k = wsKey(r.owner, r.name);
      const known = r.ports ?? this.listening.get(k);
      if (known) listening.set(k, known);
    }
    this.listening = listening;
    const showing = this.d.panel?.context() ?? null;
    const earned = metroOffers(this.portMem, readings, (o) => showing !== null && wsKey(showing.owner, showing.name) === wsKey(o.owner, o.name) && showing.remote === o.port);
    this.portMem = earned.next;
    const offers = admitOffers(earned.offers, this.offeredAt, Date.now());
    this.offerCount += offers.length;
    if (offers.length > 0) this.lastOffer = offers[offers.length - 1] ?? null;
    const clicks = new Map<Item, () => void>();
    const items = offers.map((o) => {
      const device = this.d.memory.get(o.owner, o.name)?.name ?? "the iPhone simulator";
      const item: Item = { title: clean(`${o.name}'s app is running`, 60), body: clean(`Open it on ${device}`, 120), route: workspaceRoute(o.owner, o.name) ?? "#/" };
      clicks.set(item, () => { void this.takeOffer(o); });
      return item;
    });
    for (const item of this.offerLimiter.admit(items, Date.now())) sink.show(item, clicks.get(item) ?? (() => this.d.openRoute(item.route)));
  }

  /** An offer clicked, perhaps long after it was made (a notification stays in Notification Center): it opens the app only while
      that workspace is still running with Metro listening on that port, as the last read said; otherwise it says so and does nothing. */
  async takeOffer(o: Offer): Promise<void> {
    if (!this.listening.get(wsKey(o.owner, o.name))?.includes(o.port)) {
      const route = workspaceRoute(o.owner, o.name) ?? "#/";
      for (const item of this.limiter.admit([{ title: clean(`${o.name}'s app has stopped`, 60), body: clean(`Metro is no longer running on ${o.port}`, 120), route }], Date.now())) sink.show(item, () => this.d.openRoute(item.route));
      return;
    }
    await this.openInSimulator(o.owner, o.name, o.port);
  }

  private render(): void {
    this.menu = buildMenu({ inOerba: this.inOerba, now: this.now, loginItem: app.getLoginItemSettings().openAtLogin, paletteKey: this.keys.palette, chatKey: this.keys.chat, update: this.update, forwards: this.d.relay.list(), listening: this.listening });
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
    } else {
      // Metro's, Expo's, and since 0.6.0 any other port the workspace listens on: the browser is opened for the web ports alone.
      say("Oerba", `localhost:${local}${local === remote ? "" : ` (${remote} was taken)`} → ${name}'s ${remote}`);
    }
  }

  /** The press "Open in iOS Simulator" on a Metro port: starts the forward if it is not running, then runs src/sim/'s sequence at the
      number the forward took, and says in one notification what it did. A press while one is running is ignored. Only the menu calls it. */
  async openInSimulator(owner: string, name: string, port: number, udid: string | null = null): Promise<void> {
    if (!METRO_PORTS.includes(port)) return;
    const route = workspaceRoute(owner, name) ?? "#/";
    const say = (title: string, body: string): void => {
      for (const item of this.limiter.admit([{ title: clean(title, 60), body: clean(body, 200), route }], Date.now())) sink.show(item, () => this.d.openRoute(item.route));
    };
    // From the panel's picker (a device named) the bar says how it goes, and a success is not notified: the panel shows it.
    const picked = udid !== null;
    await this.simPress.run(async () => {
      if (picked) this.d.panel?.say(`Opening on ${this.choices.get(udid.toUpperCase()) ?? "that device"}…`);
      const f = await this.d.relay.tryStart(owner, name, port);
      this.render();
      if ("why" in f) { say("Could not open the port", `${name}'s ${port}: ${f.why}`); if (picked) this.d.panel?.say("Could not open the port."); return; }
      const panelled = this.d.panel !== undefined;
      const preferred = udid ?? this.d.memory.get(owner, name)?.udid ?? null;
      const outcome = await openInSimulator(f.info.local, simulator.run, { window: !panelled, udid: preferred });
      if (outcome.kind === "opened") {
        this.d.memory.set(owner, name, { udid: outcome.udid, name: clean(outcome.name, 60) || "iPhone" });
        if (this.d.panel) await this.d.panel.show(outcome.udid, outcome.name, { owner, name, remote: port });
      }
      const words = describe(outcome);
      if (picked && outcome.kind !== "opened") this.d.panel?.say(`${words.title}.`);
      if (!picked || outcome.kind !== "opened") say(words.title, words.body);
      if (outcome.kind === "opened" && !this.hinted) {
        this.hinted = true;
        const h = expoHint();
        say(h.title, h.body);
      }
    });
  }

  /** The dev panel's device picker: this Mac's simulators, from simctl's own list read here (no device is named by the bar or any
      page), the running ones first and the one shown ticked. Null while the panel is closed, or when Xcode could not be asked,
      which the bar then says. */
  async deviceMenu(): Promise<MenuItem[] | null> {
    if (!this.d.panel?.context()) return null;
    const listed = await listDevices(simulator.run);
    if (listed.kind !== "ok") { this.d.panel.say(`${describe({ kind: listed.kind }).title}.`); return null; }
    const current = this.d.panel.device()?.toUpperCase() ?? null;
    this.choices = new Map(listed.devices.map((d) => [d.udid.toUpperCase(), clean(d.name, 60) || "Simulator"]));
    const items: MenuItem[] = [];
    for (const g of pickerGroups(listed.devices)) {
      if (items.length > 0) items.push({ label: "", kind: "separator" });
      items.push({ label: g.title, enabled: false });
      for (const d of g.devices) {
        const label = this.choices.get(d.udid.toUpperCase()) ?? "Simulator";
        items.push({ label: g.title === "Running" ? `${label}  ${runtimeLabel(d.runtime)}` : label, kind: "checkbox", checked: d.udid.toUpperCase() === current, action: { type: "device", udid: d.udid } });
      }
    }
    if (items.length === 0) items.push({ label: "No simulators: Xcode, Settings, Components installs the iOS platform", enabled: false });
    return items;
  }

  /** The bar's device button: the picker, popped under it. */
  async chooseDevice(): Promise<void> {
    const items = await this.deviceMenu();
    if (items === null || !this.d.panel) return;
    this.d.panel.popup(Menu.buildFromTemplate(items.map((m) => this.toNative(m))));
  }

  /** A device chosen in the picker: one the last picker listed, for the workspace and app the panel shows, or nothing. */
  async pickDevice(udid: string): Promise<void> {
    const ctx = this.d.panel?.context();
    if (!ctx || !this.choices.has(udid.toUpperCase())) return;
    await this.openInSimulator(ctx.owner, ctx.name, ctx.remote, udid);
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
    else if (a.type === "device") void this.pickDevice(a.udid);
    else if (a.type === "stop") void this.d.relay.stop(a.id).then(() => this.render());
    else if (a.type === "login") app.setLoginItemSettings({ openAtLogin: checked });   // only when the person ticks it
    else this.d.quit();
  }
}
