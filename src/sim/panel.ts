/* The iPhone panel: a column at the right of Oerba's window, drawn by the app beside Oerba's page, which it does not touch. Its bar
   is a bundled page (the device's name and Close); below it, serve-sim's own preview of the simulator, where a click is a
   tap and typing types. The preview is a view of its own:
   - its role ("simulator") lets its top frame be serve-sim's page at the one origin running now, and nothing else, and it may
     make no frames;
   - its session is its own and in memory alone, so serve-sim's cookie never meets Oerba's and is gone when the app quits;
   - it gets no preload, and every permission, download and window is refused, as for every view (src/shell/hardening.ts).
   - its requests may reach serve-sim's origin alone (previewRequestAllowed).
   It is opened only by the app's own menu, after "Open in iOS Simulator" has opened the workspace's app in Expo Go. Closing it,
   closing (hiding) the window, quitting and restarting for an update each stop serve-sim. It has had no Pop out (to Device
   Hub) since 0.5.2: the owner had it taken off, the panel being where the phone is shown. */

import { BrowserWindow, ipcMain, session, WebContentsView, type IpcMainInvokeEvent, type WebPreferences } from "electron";
import path from "node:path";
import { isSimbarSender, type NavPolicy } from "../policy/navigation";
import { refusals, setRole } from "../shell/hardening";
import { BAR_HEIGHT, panelWidth, previewRequestAllowed, previewUrl } from "./serve";
import { SimServer, type SimServing } from "./server";

/** The preview's session: named, so that every preview shares one, and without "persist:", so it is kept in memory alone. */
export const SIM_PARTITION = "oerba-iphone-panel";

export interface PanelHooks {
  window(): BrowserWindow | null;
  /** Oerba's own view is laid out again: the panel took, or gave back, its width. */
  relayout(): void;
  /** Why the panel may not start here, or null. A packed app outside Applications (run from its disk image, or moved by macOS to
      a random place) is refused: serve-sim names a library inside the app to the simulator, and a path that does not last could
      later hold something else, were serve-sim to stop without taking it out. */
  refuse(): string | null;
}

export class SimPanel {
  private bar: WebContentsView | null = null;
  private preview: WebContentsView | null = null;
  private udid: string | null = null;
  private state = { name: "iPhone", status: "" };

  /** What the bar says now: its device's name, and why the panel is not showing it, if it is not. */
  get status(): { name: string; status: string } { return this.state; }
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
    });
  }

  /** Whether the panel is showing. */
  get open(): boolean { return this.bar !== null; }

  /** The width the panel takes from the window now: none while it is closed. */
  width(windowWidth: number): number { return this.open ? panelWidth(windowWidth) : 0; }

  /** Shows the panel for this device and starts serve-sim for it; a panel already open for another device moves to this one. */
  async show(udid: string, name: string): Promise<void> {
    const win = this.hooks.window();
    if (!win) return;
    this.udid = udid;
    // A preview of another device, or of a serve-sim no longer running, goes first: its origin is allowed no longer.
    if (this.server.running?.udid !== udid) this.dropPreview();
    const refused = this.hooks.refuse();
    this.say({ name, status: refused ?? "Starting…" });
    if (!this.bar) {
      this.bar = new WebContentsView({ webPreferences: { ...this.safe, preload: path.join(__dirname, "preload-simbar.js") } });
      setRole(this.bar.webContents, "simbar");
      win.contentView.addChildView(this.bar);
      void this.bar.webContents.loadURL(this.policy.simbarUrl);
    }
    this.layout();
    this.hooks.relayout();
    if (refused !== null) return;
    const started = await this.server.start(udid);
    // Closed while it started: whatever started is stopped, so that nothing runs, or stays armed in the simulator, without a panel.
    if (this.udid !== udid || !this.bar) { await this.server.stop(); return; }
    if ("why" in started) {
      this.dropPreview();
      this.say({ name, status: `Could not start: ${started.why}.` });
      return;
    }
    this.policy.simOrigin = started.origin;
    if (!this.preview) {
      // No preload: serve-sim's page gets no bridge of any kind.
      this.preview = new WebContentsView({ webPreferences: { ...this.safe, partition: SIM_PARTITION } });
      setRole(this.preview.webContents, "simulator");
      win.contentView.addChildView(this.preview);
    }
    this.layout();
    void this.preview.webContents.loadURL(previewUrl(started.port, started.token));
    this.say({ name, status: "" });
  }

  /** Lays the bar and the preview out in the right-hand column of the window. */
  layout(): void {
    const win = this.hooks.window();
    if (!win || !this.bar) return;
    const [width = 0, height = 0] = win.getContentSize();
    const w = panelWidth(width);
    this.bar.setBounds({ x: width - w, y: 0, width: w, height: BAR_HEIGHT });
    this.preview?.setBounds({ x: width - w, y: BAR_HEIGHT, width: w, height: Math.max(0, height - BAR_HEIGHT) });
  }

  /** Closes the panel and stops serve-sim. */
  async close(): Promise<void> {
    const win = this.hooks.window();
    this.udid = null;
    this.dropPreview();
    const bar = this.bar;
    this.bar = null;
    if (bar) {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(bar);
      if (!bar.webContents.isDestroyed()) bar.webContents.close();
    }
    this.hooks.relayout();
    await this.server.stop();
  }

  /** The preview goes, and with it the origin it was allowed. */
  private dropPreview(): void {
    this.policy.simOrigin = null;
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
    if (this.bar) this.say({ ...this.state, status: "The panel's helper stopped. Open in iOS Simulator starts it again." });
  }

  private say(s: { name: string; status: string }): void {
    this.state = s;
    if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.send("simbar:state", s);
  }
}
