/* The dev panel (the iPhone panel until 0.6.0): a column at the right of Oerba's window, drawn by the app beside Oerba's page, which
   it does not touch. Its bar is a bundled page (the device button, which opens the device picker, the workspace and app it shows,
   and Close); below it, serve-sim's own preview of the simulator, where a click is a
   tap and typing types. The preview is a view of its own:
   - its role ("simulator") lets its top frame be serve-sim's page at the one origin running now, and nothing else, and it may
     make no frames;
   - its session is its own and in memory alone, so serve-sim's cookie never meets Oerba's and is gone when the app quits;
   - it gets no preload, and every permission, download and window is refused, as for every view (src/shell/hardening.ts).
   - its requests may reach serve-sim's origin alone (previewRequestAllowed).
   It is opened only by the person, from the app's own menus: after "Open in iOS Simulator" has opened the workspace's app in Expo
   Go, or by Dev Panel (0.6.1), with no app. Closing it,
   closing (hiding) the window, quitting and restarting for an update each stop serve-sim. It has had no Pop out (to Device
   Hub) since 0.5.2: the owner had it taken off, the panel being where the phone is shown. */

import { BrowserWindow, ipcMain, session, WebContentsView, type IpcMainInvokeEvent, type Menu, type WebPreferences } from "electron";
import path from "node:path";
import { isSimbarSender, type NavPolicy } from "../policy/navigation";
import { refusals, setRole } from "../shell/hardening";
import { appLabel } from "./decide";
import { BAR_HEIGHT, panelWidth, previewRequestAllowed, previewUrl } from "./serve";
import { SimServer, type SimServing } from "./server";

/** The preview's session: named, so that every preview shares one, and without "persist:", so it is kept in memory alone. */
export const SIM_PARTITION = "oerba-iphone-panel";

export interface PanelHooks {
  window(): BrowserWindow | null;
  /** Oerba's own view is laid out again: the panel took, or gave back, its width. */
  relayout(): void;
  /** The bar's device button was pressed: the device picker is made (from simctl's own list, in the main process) and popped. */
  choose(): void;
  /** The panel opened or closed: the menus' Dev Panel item follows. */
  changed(): void;
  /** Why the panel may not start here, or null. A packed app outside Applications (run from its disk image, or moved by macOS to
      a random place) is refused: serve-sim names a library inside the app to the simulator, and a path that does not last could
      later hold something else, were serve-sim to stop without taking it out. */
  refuse(): string | null;
}

/** What the panel shows: a workspace's Metro port, by the workspace's owner and name and the port's number in the workspace. */
export interface PanelContext { owner: string; name: string; remote: number }

export interface BarState { device: string; app: string; status: string; loading: boolean }

/** What the bar says while the panel shows a device and no app (it was opened on its own, from the menus' Dev Panel). */
export const NO_APP = "Start Metro in a workspace to open its app here";

export class SimPanel {
  private bar: WebContentsView | null = null;
  private preview: WebContentsView | null = null;
  private udid: string | null = null;
  private ctx: PanelContext | null = null;
  private state: BarState = { device: "iPhone", app: "", status: "", loading: false };
  /** Whether serve-sim's page has loaded in the preview: until it has, the bar fills the column and says what is happening. */
  private previewReady = false;
  /** Each load of the preview's, so that only the latest reveals it; and its ten seconds' timer. */
  private loads = 0;
  private revealTimer: NodeJS.Timeout | null = null;

  /** What the bar says now: its device's name, the workspace and app, and what the panel is doing or why it is not showing it. */
  get status(): BarState { return this.state; }
  /** The workspace and port the panel shows, while it is open with an app; null with none, or closed. */
  get context(): PanelContext | null { return this.ctx; }
  /** The device it shows, while it is open. */
  get device(): string | null { return this.udid; }
  /** serve-sim. Replaced only by the self-test, with one that starts nothing. */
  server: SimServing = new SimServer();

  constructor(private readonly policy: NavPolicy, private readonly safe: WebPreferences, private readonly hooks: PanelHooks) {
    this.server.onGone = () => this.lost();
    // The preview's session reaches serve-sim's origin and nothing else (previewRequestAllowed).
    session.fromPartition(SIM_PARTITION).webRequest.onBeforeRequest((details, callback) => {
      const ok = previewRequestAllowed(details.url, this.policy.simOrigin);
      if (!ok) refusals.push(`panel-request:${details.url.slice(0, 80)}`);
      callback({ cancel: !ok });
    });
    const from = (e: IpcMainInvokeEvent): boolean =>
      this.bar !== null && e.sender === this.bar.webContents && isSimbarSender(e.senderFrame?.url, e.senderFrame === e.sender.mainFrame, this.policy);
    ipcMain.handle("simbar:get", (e) => (from(e) ? this.state : null));
    ipcMain.handle("simbar:act", async (e, action: unknown) => {
      if (!from(e)) return;
      if (action === "close") await this.close();
      else if (action === "devices") this.hooks.choose();
    });
  }

  /** Whether the panel is showing. */
  get open(): boolean { return this.bar !== null; }

  /** The width the panel takes from the window now: none while it is closed. */
  width(windowWidth: number): number { return this.open ? panelWidth(windowWidth) : 0; }

  /** Shows the panel for this device and this workspace's app (none, opened on its own), and starts serve-sim for it; a panel
      already open for another device moves to this one, and one already showing this device keeps its serve-sim and preview. */
  async show(udid: string, name: string, ctx: PanelContext | null): Promise<void> {
    const win = this.hooks.window();
    if (!win) return;
    this.udid = udid;
    this.ctx = ctx;
    const idle = ctx ? "" : NO_APP;
    if (this.bar && this.preview && this.previewReady && this.server.alive && this.server.running?.udid === udid) { this.put({ device: name, status: idle, loading: false }); return; }
    // A preview of another device, or of a serve-sim no longer running, goes first: its origin is allowed no longer.
    if (this.server.running?.udid !== udid) { this.dropPreview(); this.layout(); }
    const refused = this.hooks.refuse();
    this.put({ device: name, status: refused ?? "Starting the panel…", loading: refused === null });
    this.openBar(win);
    if (refused !== null) return;
    const started = await this.server.start(udid);
    // Closed while it started: whatever started is stopped, so that nothing runs, or stays armed in the simulator, without a panel.
    if (this.udid !== udid || !this.bar) { await this.server.stop(); return; }
    if ("why" in started) {
      this.dropPreview();
      this.layout();
      this.put({ device: name, status: `Could not start: ${started.why}.`, loading: false });
      return;
    }
    this.policy.simOrigin = started.origin;
    if (!this.preview) {
      // No preload: serve-sim's page gets no bridge of any kind.
      this.preview = new WebContentsView({ webPreferences: { ...this.safe, partition: SIM_PARTITION } });
      setRole(this.preview.webContents, "simulator");
      win.contentView.addChildView(this.preview);
    }
    // Hidden until its page has loaded (or ten seconds have passed), the bar's loading state showing meanwhile; a page that did not
    // load stays hidden, and the bar says so. Only this load's events count: an earlier show's are let go.
    const preview = this.preview;
    const load = ++this.loads;
    this.previewReady = false;
    this.layout();
    this.put({ device: name, status: "Loading the phone…", loading: true });
    let failed = false;
    const current = (): boolean => this.preview === preview && this.loads === load;
    const reveal = (): void => {
      if (!current() || failed || this.previewReady) return;
      this.clearReveal();
      this.previewReady = true;
      this.layout();
      this.put({ device: name, status: idle, loading: false });
    };
    const fail = (_e: unknown, code: number, _what: string, _url: string, mainFrame: boolean): void => {
      if (!current() || !mainFrame || code === -3) return;   // -3: a load given up for another, which says nothing
      failed = true;
      this.clearReveal();
      this.put({ device: name, status: "Could not load the phone's picture. Close the panel and open it again.", loading: false });
    };
    preview.webContents.once("did-finish-load", reveal);
    preview.webContents.once("did-fail-load", fail);
    this.clearReveal();
    this.revealTimer = setTimeout(reveal, 10_000);
    this.revealTimer.unref?.();
    void preview.webContents.loadURL(previewUrl(started.port, started.token)).catch(() => undefined);
  }

  /** Opens the column, if it is not open, with the bar alone, which fills it until a preview has loaded. */
  private openBar(win: BrowserWindow): void {
    const opening = this.bar === null;
    if (!this.bar) {
      this.bar = new WebContentsView({ webPreferences: { ...this.safe, preload: path.join(__dirname, "preload-simbar.js") } });
      setRole(this.bar.webContents, "simbar");
      win.contentView.addChildView(this.bar);
      void this.bar.webContents.loadURL(this.policy.simbarUrl);
    }
    this.layout();
    this.hooks.relayout();
    if (opening) this.hooks.changed();
  }

  /** Opens the panel at once, if it is not open, saying what is under way (a simulator starting, an app opening) with the loading
      state, before the device is ready; show() follows, or say() with why not. */
  loading(status: string, device: string | null = null): void {
    const win = this.hooks.window();
    if (!win) return;
    this.openBar(win);
    this.put({ ...(device ? { device } : {}), status, loading: true });
  }

  /** Lays the bar and the preview out in the right-hand column of the window. */
  layout(): void {
    const win = this.hooks.window();
    if (!win || !this.bar) return;
    const [width = 0, height = 0] = win.getContentSize();
    const w = panelWidth(width);
    // The bar fills the column until a preview has loaded: its page then shows the loading state, or why the panel is empty.
    this.bar.setBounds({ x: width - w, y: 0, width: w, height: this.preview && this.previewReady ? BAR_HEIGHT : height });
    this.preview?.setBounds({ x: width - w, y: BAR_HEIGHT, width: w, height: Math.max(0, height - BAR_HEIGHT) });
    this.preview?.setVisible(this.previewReady);
  }

  /** Says what the panel is doing (a device starting) or why it did not, in the bar. Nothing while it is closed. */
  say(s: Partial<BarState>): void {
    if (!this.bar) return;
    this.put({ loading: false, ...s });
  }

  /** Pops the device picker just under the bar's device button. */
  popup(menu: Menu): void {
    const win = this.hooks.window();
    if (!win || !this.bar) return;
    const [width = 0] = win.getContentSize();
    menu.popup({ window: win, x: width - panelWidth(width) + 8, y: BAR_HEIGHT });
  }

  /** Closes the panel and stops serve-sim. */
  async close(): Promise<void> {
    const win = this.hooks.window();
    this.udid = null;
    this.ctx = null;
    this.dropPreview();
    const bar = this.bar;
    this.bar = null;
    if (bar) {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(bar);
      if (!bar.webContents.isDestroyed()) bar.webContents.close();
    }
    this.hooks.relayout();
    if (bar) this.hooks.changed();
    await this.server.stop();
  }

  private clearReveal(): void {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = null;
  }

  /** The preview goes, and with it the origin it was allowed. */
  private dropPreview(): void {
    this.clearReveal();
    this.policy.simOrigin = null;
    this.previewReady = false;
    const v = this.preview;
    this.preview = null;
    if (!v) return;
    const win = this.hooks.window();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(v);
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }

  /** serve-sim stopped by itself: the preview goes, and with it the origin it was allowed, so that nothing which later answers on
      that port is shown; the bar stays and says so. */
  private lost(): void {
    this.dropPreview();
    this.layout();
    if (this.bar) this.put({ loading: false, status: this.ctx ? "The panel's helper stopped. Open in iOS Simulator starts it again." : "The panel's helper stopped. Close the panel and choose Dev Panel to start it again." });
  }

  /** Records what the bar says, the workspace and app always from the panel's context, and sends it to the bar if it is there. */
  private put(s: Partial<BarState>): void {
    this.state = { ...this.state, ...s, app: this.ctx ? appLabel(this.ctx.name, this.ctx.remote) : "" };
    if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.send("simbar:state", this.state);
  }
}
