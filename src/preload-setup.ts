/* The only preload in the app, given to the bundled setup page and to no other. It exposes three calls and nothing else
   (no ipcRenderer, no event object), and does nothing at all if the page it runs in is not the setup page. The main
   process checks the sender again on every message, so this is a second lock, not the only one. */

import { contextBridge, ipcRenderer } from "electron";

const bundled = location.protocol === "file:" && location.pathname.endsWith("/setup/setup.html") && window.top === window;

if (bundled) {
  contextBridge.exposeInMainWorld("oerbaSetup", {
    getState: (): Promise<unknown> => ipcRenderer.invoke("setup:get"),
    onState: (cb: (state: unknown) => void): void => { ipcRenderer.on("setup:state", (_event, state: unknown) => cb(state)); },
    act: (action: "open-tailscale-download" | "recheck"): Promise<void> => ipcRenderer.invoke("setup:act", action),
  });
}
