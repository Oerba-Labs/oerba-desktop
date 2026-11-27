/* The iPhone panel: a column at the right of Oerba's window, drawn by the app beside Oerba's page, which it does not touch. Its bar
   is a bundled page (the device's name, Pop out, Close); below it, serve-sim's own preview of the simulator, where a click is a
   tap and typing types. The preview is a view of its own:
   - its role ("simulator") lets its top frame be serve-sim's page at the one origin running now, and nothing else, and it may
     make no frames;
   - its session is its own and in memory alone, so serve-sim's cookie never meets Oerba's and is gone when the app quits;
   - it gets no preload, and every permission, download and window is refused, as for every view (src/shell/hardening.ts).
   It is opened only by the app's own menu, after "Open in iOS Simulator" has opened the workspace's app in Expo Go. Closing it,
   Pop out, closing the window and quitting each stop serve-sim. */

import { BrowserWindow, ipcMain, WebContentsView, type IpcMainInvokeEvent, type WebPreferences } from "electron";
import path from "node:path";
import { isSimbarSender, type NavPolicy } from "../policy/navigation";
import { setRole } from "../shell/hardening";
import { BAR_HEIGHT, panelWidth, previewUrl } from "./serve";
import { SimServer, type SimServing } from "./server";

/** The preview's session: named, so that every preview shares one, and without "persist:", so it is kept in memory alone. */
export const SIM_PARTITION = "oerba-iphone-panel";

export interface PanelHooks {
  window(): BrowserWindow | null;
  /** Oerba's own view is laid out again: the panel took, or gave back, its width. */
  relayout(): void;
  /** Shows the device in Device Hub (Simulator on Xcode 26 and earlier). */
  popOut(udid: string): Promise<boolean>;
}

export class SimPanel {
  private bar: WebContentsView | null = null;
  private preview: WebContentsView | null = null;
  private udid: string | null = null;
  private state = { name: "iPhone", status: "" };
  /** serve-sim. Replaced only by the self-test, with a stand-in that starts nothing. */
  server: SimServing = new SimServer();

  constructor(private readonly policy: NavPolicy, private readonly safe: WebPreferences, private readonly hooks: PanelHooks) {
    const from = (e: IpcMainInvokeEvent): boolean =>
      this.bar !== null && e.sender === this.bar.webContents && isSimbarSender(e.senderFrame?.url, e.senderFrame === e.sender.mainFrame, this.policy);
    ipcMain.handle("simbar:get", (e) => (from(e) ? this.state : null));
    ipcMain.handle("simbar:act", async (e, action: unknown) => {
      if (!from(e)) return;
      if (action === "close") await this.close();
      else if (action === "popout") await this.popOut();
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
    this.say({ name, status: "Starting…" });
    if (!this.bar) {
      this.bar = new WebContentsView({ webPreferences: { ...this.safe, preload: path.join(__dirname, "preload-simbar.js") } });
      setRole(this.bar.webContents, "simbar");
      win.contentView.addChildView(this.bar);
      void this.bar.webContents.loadURL(this.policy.simbarUrl);
    }
    this.layout();
    this.hooks.relayout();
    const started = await this.server.start(udid);
    if (this.udid !== udid || !this.bar) return;   // closed, or moved to another device, while it started
    if ("why" in started) {
      this.say({ name, status: `Could not start: ${started.why}. Pop out shows it in Device Hub.` });
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
    this.policy.simOrigin = null;
    for (const v of [this.preview, this.bar]) {
      if (!v) continue;
      if (win && !win.isDestroyed()) win.contentView.removeChildView(v);
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
    this.preview = null;
    this.bar = null;
    this.hooks.relayout();
    await this.server.stop();
  }

  /** Shows the device in Device Hub and closes the panel, so that the phone is driven from one place at a time. */
  private async popOut(): Promise<void> {
    const udid = this.udid;
    if (udid === null) return;
    const shown = await this.hooks.popOut(udid);
    if (shown) await this.close();
    else this.say({ ...this.state, status: "Device Hub could not be opened." });
  }

  private say(s: { name: string; status: string }): void {
    this.state = s;
    if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.send("simbar:state", s);
  }
}
