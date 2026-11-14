/* The policies of src/policy/, wired to Electron. No decision is made here: each handler asks the pure modules. */

import { app, session, shell, type Session, type WebContents } from "electron";
import { externalTarget, navigationAllowed, openDecision, type NavPolicy, type Role } from "../policy/navigation";
import { deviceAllowed, DEVICE_EVENTS, permissionAllowed } from "../policy/permissions";

/** What was refused, kept for the self-test to read. */
export const refusals: string[] = [];
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
      if (event.defaultPrevented && event.isMainFrame && !event.isSameDocument && roleOf(wc) === "oerba") {
        const target = externalTarget(event.url);
        if (target !== null) void shell.openExternal(target);
      }
    });
    wc.on("will-redirect", (event) => guard(event, "redirect"));

    // A link or window.open to anywhere: never a window of ours. The system browser takes an https address.
    wc.setWindowOpenHandler(({ url }) => {
      const d = openDecision(url);
      if (d.external !== null) void shell.openExternal(d.external);
      else refusals.push("open:refused");
      return { action: d.action };
    });

    // Bluetooth's chooser belongs to the contents; serial, USB and HID's belong to the session (hardenSession).
    refuseChooser(wc, "select-bluetooth-device");
  });
}
