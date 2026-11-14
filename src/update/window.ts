/* The update window: a small window of the app's own, showing the version and the release's notes with Download and
   Later, then Restart now once the download is done. Its page is bundled; its preload is its own and goes to no other page. */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebPreferences } from "electron";
import path from "node:path";
import { isUpdateSender, type NavPolicy } from "../policy/navigation";
import { setRole } from "../shell/hardening";
import type { Updater } from "./updater";

export class UpdateWindow {
  private win: BrowserWindow | null = null;

  constructor(private readonly policy: NavPolicy, private readonly safe: WebPreferences, private readonly updater: Updater, private readonly quiet: boolean) {
    const from = (e: IpcMainInvokeEvent): boolean =>
      this.win !== null && e.sender === this.win.webContents && isUpdateSender(e.senderFrame?.url, e.senderFrame === e.sender.mainFrame, this.policy);
    ipcMain.handle("update:get", (e) => (from(e) ? this.updater.state : null));
    ipcMain.handle("update:act", async (e, action: unknown) => {
      if (!from(e)) return;
      if (action === "download") await this.updater.download();
      else if (action === "restart") await this.updater.restart();
      else if (action === "later") this.win?.close();
    });
  }

  get window(): BrowserWindow | null { return this.win; }

  show(): void {
    if (this.win) { this.win.show(); this.win.focus(); return; }
    const w = new BrowserWindow({
      width: 480, height: 420, minWidth: 380, minHeight: 320, show: !this.quiet, title: "Oerba update", backgroundColor: "#F6F7F9",
      minimizable: false, maximizable: false,
      webPreferences: { ...this.safe, preload: path.join(__dirname, "preload-update.js") },
    });
    setRole(w.webContents, "update");
    w.on("closed", () => { this.win = null; });
    this.win = w;
    void w.loadURL(this.policy.updateUrl);
  }

  /** Tells an open window what changed. */
  push(): void { if (this.win && !this.win.webContents.isDestroyed()) this.win.webContents.send("update:state", this.updater.state); }
}
