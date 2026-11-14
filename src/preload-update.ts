/* The preload of the bundled update window, and of nothing else: three calls through contextBridge, and nothing at all
   unless the page is the bundled update page in its own top frame. The main process checks the sender again on every message. */

import { contextBridge, ipcRenderer } from "electron";

const bundled = location.protocol === "oerba-app:" && location.host === "app" && location.pathname === "/update/update.html" && window.top === window;

if (bundled) {
  contextBridge.exposeInMainWorld("oerbaUpdate", {
    getState: (): Promise<unknown> => ipcRenderer.invoke("update:get"),
    onState: (cb: (state: unknown) => void): void => { ipcRenderer.on("update:state", (_event, state: unknown) => cb(state)); },
    act: (action: "download" | "restart" | "later"): Promise<void> => ipcRenderer.invoke("update:act", action),
  });
}
