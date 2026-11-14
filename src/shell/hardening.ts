/* The policies of src/policy/, wired to Electron. No decision is made here: each handler asks the pure modules. */

import { app, session, shell, type Session, type WebContents, type WebFrameMain } from "electron";
import { LinkOutGate } from "../policy/linkout";
import { externalTarget, isOerbaPage, navigationAllowed, openDecision, type NavPolicy, type Role } from "../policy/navigation";
import { RefusalLog } from "../policy/refusals";
import { deviceAllowed, DEVICE_EVENTS, permissionAllowed } from "../policy/permissions";

/** What was refused: the newest 200, and a count of all. Read by the self-test. */
export const refusals = new RefusalLog(200);
/** How a link leaves for the system browser. The self-test replaces it with a recorder; nothing else does. */
export const external = { open: (url: string): void => { void shell.openExternal(url); } };
const gates = new Map<number, LinkOutGate>();
const gateOf = (wc: WebContents): LinkOutGate => { let g = gates.get(wc.id); if (!g) { g = new LinkOutGate(); gates.set(wc.id, g); } return g; };
const sameFrame = (a: WebFrameMain | null | undefined, b: WebFrameMain | null | undefined): boolean =>
  !!a && !!b && a.processId === b.processId && a.routingId === b.routingId;
/** Whether the frame is the top frame of an Oerba view showing one of Oerba's own pages. */
const isOerbaTop = (wc: WebContents, frame: WebFrameMain | null | undefined, policy: NavPolicy): boolean =>
  roleOf(wc) === "oerba" && sameFrame(frame, wc.mainFrame) && isOerbaPage(wc.mainFrame.url, policy);
const roles = new Map<number, Role>();

export const setRole = (wc: WebContents, role: Role): void => { roles.set(wc.id, role); };
const roleOf = (wc: WebContents): Role => roles.get(wc.id) ?? "other";   // a contents nobody named may go nowhere

export function hardenSession(ses: Session, policy: NavPolicy): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = permissionAllowed(permission, { origin: originOf(details.requestingUrl), isMainFrame: details.isMainFrame }, policy.oerbaOrigin);
    if (!ok) refusals.push(`permission:${permission}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const ok = permissionAllowed(permission, { origin: originOf(requestingOrigin), isMainFrame: details.isMainFrame ?? false }, policy.oerbaOrigin);
    if (!ok) refusals.push(`check:${permission}`);
    return ok;
  });
  ses.setDevicePermissionHandler(() => { refusals.push("device"); return deviceAllowed(); });
  // Nobody records the screen or a window: a display-media request is answered with no source.
  ses.setDisplayMediaRequestHandler((_request, callback) => { refusals.push("display-media"); callback({}); });
  // No downloads in any session until a stage needs them.
  ses.on("will-download", (event) => { event.preventDefault(); refusals.push("download"); });
  // A device chooser is a person's act on Oerba's own screens, and stage 1 has none: choose nothing.
  for (const name of DEVICE_EVENTS) if (name !== "select-bluetooth-device") refuseChooser(ses, name);
}

type Emitter = { on(event: string, listener: (event: { preventDefault(): void }, ...rest: unknown[]) => void): unknown };

/** Cancels a device chooser: the request is told no device was chosen. */
function refuseChooser(target: Session | WebContents, name: string): void {
  (target as unknown as Emitter).on(name, (event, ...rest) => {
    event.preventDefault();
    refusals.push(name);
    const callback = rest[rest.length - 1];
    if (typeof callback === "function") (callback as (id?: string) => void)(name === "select-serial-port" ? "" : undefined);
  });
}

const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ""; } };

function linkOut(wc: WebContents, fromTop: boolean, url: string): void {
  const verdict = gateOf(wc).decide(fromTop, Date.now());
  if (verdict === "open") external.open(url);
  else refusals.push(`linkout:${verdict}`);
}

/** Every web contents the app ever makes, in any session, passes through here before it loads anything. */
export function installHardening(policy: NavPolicy): void {
  app.on("session-created", (ses) => hardenSession(ses, policy));
  hardenSession(session.defaultSession, policy);

  app.on("web-contents-created", (_e, wc) => {
    // No <webview>, ever.
    wc.on("will-attach-webview", (event) => { event.preventDefault(); refusals.push("webview"); });

    const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }, kind: string): void => {
      if (!navigationAllowed(event.url, event.isMainFrame, roleOf(wc), policy)) {
        event.preventDefault();
        refusals.push(`${kind}:${event.isMainFrame ? "main" : "sub"}`);
      }
    };
    wc.on("will-frame-navigate", (event) => {
      guard(event, "navigate");
      // A plain link out of Oerba's page, in its own frame, goes to the browser if it is https; the page itself stays.
      // Only when Oerba's own top frame asked, just after a press: a frame inside it never opens the browser.
      if (event.defaultPrevented && event.isMainFrame && !event.isSameDocument && roleOf(wc) === "oerba") {
        const target = externalTarget(event.url);
        if (target !== null) linkOut(wc, isOerbaTop(wc, event.initiator, policy), target);
      }
    });
    wc.on("will-redirect", (event) => guard(event, "redirect"));

    // A link or window.open to anywhere: never a window of ours. The system browser takes an https address.
    // Electron does not say which frame called window.open, so the frame holding the focus stands for it: a press in a
    // frame inside Oerba's page moves the focus there, and such a request is then dropped like any other from a frame.
    wc.setWindowOpenHandler(({ url }) => {
      const d = openDecision(url);
      if (d.external !== null) linkOut(wc, isOerbaTop(wc, wc.focusedFrame, policy), d.external);
      else refusals.push("open:refused");
      return { action: d.action };
    });

    wc.on("input-event", (_e, ev) => {
      if (ev.type === "mouseDown" || ev.type === "mouseUp" || ev.type === "keyDown" || ev.type === "rawKeyDown") gateOf(wc).noteGesture(Date.now());
    });
    wc.on("destroyed", () => { gates.delete(wc.id); roles.delete(wc.id); });

    // Bluetooth's chooser belongs to the contents; serial, USB and HID's belong to the session (hardenSession).
    refuseChooser(wc, "select-bluetooth-device");
  });
}
