/* The preload of the iPhone panel's bar, and of nothing else: two calls through contextBridge, and nothing at all unless the page
   is the bundled bar in its own top frame. The main process checks the sender again on every message. */

import { contextBridge, ipcRenderer } from "electron";

const bundled = location.protocol === "oerba-app:" && location.host === "app" && location.pathname === "/simbar/simbar.html" && window.top === window;

if (bundled) {
  contextBridge.exposeInMainWorld("oerbaSimbar", {
    getState: (): Promise<unknown> => ipcRenderer.invoke("simbar:get"),
    onState: (cb: (state: unknown) => void): void => { ipcRenderer.on("simbar:state", (_event, state: unknown) => cb(state)); },
    act: (action: "close"): Promise<void> => ipcRenderer.invoke("simbar:act", action),
  });
}
