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
import { listDevices, OnePress, openInSimulator, quitExpoGo, readyDevice, simulator } from "../sim/run";
import { upstreamName } from "../relay/rules";
import type { DeviceMemory } from "../sim/remember";
import type { PanelContext } from "../sim/panel";
import { admitOffers, freshPortMemory, metroOffers, wsKey, type Offer, type PortsReader, type Reading } from "./ports";

/** What the presence asks of the dev panel (src/sim/panel.ts). */
export interface PanelDeps {
  /** Shows the panel for a device and a workspace's app, or no app (null), the window with it. */
  show(udid: string, name: string, ctx: PanelContext | null): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Opens the panel at once, if it is closed, saying what is under way with its loading state (the device's name, if known). */
  loading(status: string, device?: string | null): void;
  /** Says in the bar what is happening, or why not; nothing while the panel is closed. */
  say(status: string): void;
  /** The workspace and port it shows; null with no app, or closed. */
  context(): PanelContext | null;
  /** The device it shows, while it is open. */
  device(): { udid: string; name: string } | null;
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

/** Whether the person lets a workspace's code run in the iOS Simulator, where it can read the Mac's files (SECURITY.md): asked once for
    each workspace, before anything of it is started, and kept (src/sim/remember.ts). main sets `ask` to its dialog; until it does, the
    answer is no. The self-test replaces it with a recorder. */
export const consent = { ask: async (_owner: string, _name: string): Promise<boolean> => false };

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
  /** Counts Forgets: a question answered after one was pressed while it was open is taken as Not Now. */
  private forgets = 0;
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
      const device = this.d.panel?.device()?.name ?? this.d.memory.get(o.owner, o.name)?.name ?? "the iPhone simulator";
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
    this.menu = buildMenu({ inOerba: this.inOerba, now: this.now, loginItem: app.getLoginItemSettings().openAtLogin, paletteKey: this.keys.palette, chatKey: this.keys.chat, update: this.update, forwards: this.d.relay.list(), listening: this.listening, devPanel: this.d.panel ? { open: this.d.panel.isOpen(), allowed: this.d.memory.allowedCount() } : undefined });
    this.tray?.setContextMenu(Menu.buildFromTemplate(this.menu.map((m) => this.toNative(m))));
    // The Dock icon carries the same pieces of the same menu (so a notch cannot hide them): open, workspaces with their forwards, new chat.
    // The Dock has its own Quit.
    const dockLabels = new Set(["Open Oerba", "Workspaces", "Dev Panel", "New chat"]);
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
    // With the panel, it opens at once and says how it goes, and nothing is notified but the one tip: the panel is where it is seen.
    // Without it (an app that has none), notifications say it, as before the panel.
    const panel = this.d.panel;
    await this.simPress.run(async () => {
      // A name no forward takes is refused here, before the person is asked about a workspace that could not open anyway.
      if (upstreamName(port, name, owner) === null) {
        const why = `${name}'s ${port}: this workspace's name cannot be reached from here`;
        if (panel?.isOpen()) panel.say(clean(`Could not open ${why}.`, 120));
        else say("Could not open the port", why);
        return;
      }
      // Its code runs on this Mac there, as the person, and can read their files: asked once for each workspace, before any of it
      // starts, the forward included. Not now opens nothing and says nothing; the next press asks again.
      if (!this.d.memory.isAllowed(owner, name)) {
        const forgets = this.forgets;
        // Open after a Forget pressed while the question was open is not kept, and opens nothing: the later word wins.
        if (!(await consent.ask(owner, name)) || this.forgets !== forgets) return;
        this.d.memory.allow(owner, name);
        this.render();
      }
      // The device asked for; else the one the panel shows, where the app is looked at; else the one last used for this workspace.
      const shown = panel?.device() ?? null;
      const remembered = this.d.memory.get(owner, name);
      const preferred = udid ?? shown?.udid ?? remembered?.udid ?? null;
      const deviceName = udid !== null ? this.choices.get(udid.toUpperCase()) ?? null : shown?.name ?? remembered?.name ?? null;
      panel?.loading(clean(`Opening ${name}'s app${deviceName ? ` on ${deviceName}` : ""}…`, 120), deviceName);
      const f = await this.d.relay.tryStart(owner, name, port);
      this.render();
      if ("why" in f) {
        if (panel) panel.say(clean(`Could not open ${name}'s ${port}: ${f.why}.`, 120));
        else say("Could not open the port", `${name}'s ${port}: ${f.why}`);
        return;
      }
      const outcome = await openInSimulator(f.info.local, simulator.run, { window: !panel, udid: preferred });
      if (outcome.kind === "opened") {
        const seen = { udid: outcome.udid, name: clean(outcome.name, 60) || "iPhone" };
        this.d.memory.set(owner, name, seen);
        if (this.d.panel) { this.d.memory.setPanel(seen); await this.d.panel.show(outcome.udid, seen.name, { owner, name, remote: port }); }
      }
      const words = describe(outcome);
      if (panel) { if (outcome.kind !== "opened") panel.say(clean(`${words.title}. ${words.body}`, 200)); }
      else say(words.title, words.body);
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
    if (!this.d.panel?.isOpen()) return null;
    const listed = await listDevices(simulator.run);
    if (listed.kind !== "ok") { this.d.panel.say(`${describe({ kind: listed.kind }).title}.`); return null; }
    const current = this.d.panel.device()?.udid.toUpperCase() ?? null;
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
    const panel = this.d.panel;
    if (!panel?.isOpen() || !this.choices.has(udid.toUpperCase())) return;
    const ctx = panel.context();
    if (ctx) { await this.openInSimulator(ctx.owner, ctx.name, ctx.remote, udid); return; }
    // No app in the panel: the device alone, booted if it must be, and shown.
    await this.simPress.run(async () => {
      const chosen = this.choices.get(udid.toUpperCase()) ?? null;
      panel.loading(`Starting ${chosen ?? "that device"}…`, chosen);
      const r = await readyDevice(simulator.run, udid);
      if (r.kind !== "ready") { panel.say(`${describe({ kind: r.kind }).title}.`); return; }
      if (r.device.udid.toUpperCase() !== udid.toUpperCase()) { panel.say("That device is no longer on this Mac."); return; }
      const seen = { udid: r.device.udid, name: clean(r.device.name, 60) || "Simulator" };
      this.d.memory.setPanel(seen);
      await panel.show(seen.udid, seen.name, null);
    });
  }

  /** The menus' Dev Panel: closes the panel while it is open; otherwise opens it on its own, on the device it last showed if this
      Mac still has it, else a booted iPhone, else the first iPhone of the newest runtime, booted (readyDevice). It opens no app. */
  async toggleDevPanel(): Promise<void> {
    const panel = this.d.panel;
    if (!panel) return;
    if (panel.isOpen()) { await panel.close(); this.render(); return; }
    await this.simPress.run(async () => {
      // The panel opens at once, saying what is under way; a boot can take a minute.
      const last = this.d.memory.getPanel();
      panel.loading(`Starting ${last?.name ?? "a simulator"}…`, last?.name ?? null);
      const r = await readyDevice(simulator.run, last?.udid ?? null);
      if (r.kind !== "ready") { const words = describe({ kind: r.kind }); panel.say(clean(`${words.title}. ${words.body}`, 200)); return; }
      const seen = { udid: r.device.udid, name: clean(r.device.name, 60) || "iPhone" };
      this.d.memory.setPanel(seen);
      await panel.show(seen.udid, seen.name, null);
    });
    this.render();
  }

  /** The Dev Panel button of Oerba's page (src/policy/desktoplink.ts), pressed in a workspace's room or elsewhere: closes the panel
      while it is open; otherwise opens, in the panel, the app of the workspace named, when it is one of the person's own running
      workspaces and its Metro was listening at the last read, and else the panel alone, as the menus' Dev Panel does. */
  async devPanelFrom(ws: { owner: string; name: string } | null): Promise<void> {
    const panel = this.d.panel;
    if (!panel) return;
    const w = ws ? this.now?.workspaces.find((x) => x.status === "running" && wsKey(x.owner, x.name) === wsKey(ws.owner, ws.name)) : undefined;
    const port = w ? METRO_PORTS.find((p) => this.listening.get(wsKey(w.owner, w.name))?.includes(p)) : undefined;
    // Open with no app in it, a press in a room whose Metro listens opens that app there (0.6.3: it closed the panel, and a second
    // press was needed); open with an app, a press closes it.
    if (panel.isOpen() && !(w && port !== undefined && panel.context() === null)) { await panel.close(); this.render(); return; }
    if (w && port !== undefined) { await this.openInSimulator(w.owner, w.name, port); return; }
    await this.toggleDevPanel();
  }

  /** Every workspace's yes to run in the simulator let go (the menu's Forget item): each is asked again before it next opens there.
      What was let run is stopped with it: the panel closed (serve-sim with it) and Expo Go quit on each booted simulator, so no
      app let run before goes on running and reloading. The forwards stay, as Open on localhost uses them; Stop in the menu ends
      each. Waits for a press under way, so the stop is never dropped. */
  async forgetAllowed(): Promise<void> {
    this.forgets++;
    const written = this.d.memory.forgetAllowed();
    this.render();
    try {
      while (this.simPress.running) await new Promise((r) => setTimeout(r, 100));
      await this.simPress.run(async () => {
        try { if (this.d.panel?.isOpen()) await this.d.panel.close(); }
        finally { await quitExpoGo(simulator.run); }
      });
    } catch { /* the yes is let go whatever the stop met; the notice below still comes */ }
    this.render();
    if (!written) {
      const item = { title: "Could not forget for good", body: "This app's devices.json could not be written: each workspace is asked again until it quits, and allowed again after.", route: "#/" };
      for (const i of this.limiter.admit([item], Date.now())) sink.show(i, () => this.d.openRoute(i.route));
    }
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
    else if (a.type === "dev-panel") void this.toggleDevPanel();
    else if (a.type === "forget-allowed") void this.forgetAllowed();
    else if (a.type === "stop") void this.d.relay.stop(a.id).then(() => this.render());
    else if (a.type === "login") app.setLoginItemSettings({ openAtLogin: checked });   // only when the person ticks it
    else this.d.quit();
  }
}
