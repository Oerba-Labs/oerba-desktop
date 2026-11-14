/* What a page may ask of the computer. The answer is no, with one exception: a copy button on Oerba's own top frame. */

export interface PermissionContext {
  /** The origin that asked, as Electron gives it ("file://" or "null" for the bundled page). */
  origin: string;
  isMainFrame: boolean;
}

export const CLIPBOARD_WRITE = "clipboard-sanitized-write";

/** Every kind of permission request and check Electron raises: serial, USB, HID, Bluetooth, media, notifications,
    geolocation, clipboard read and the rest are refused, and so is a kind this list has not heard of. Writing text
    to the clipboard is allowed for Oerba's own top frame only, since Oerba's copy buttons use it and it reads nothing. */
export function permissionAllowed(permission: string, ctx: PermissionContext, oerbaOrigin: string): boolean {
  return permission === CLIPBOARD_WRITE && ctx.isMainFrame && ctx.origin === oerbaOrigin;
}

/** A device a page may be handed (serial, USB, HID, Bluetooth): none, ever. Oerba's own screens ask for none in stage 1. */
export function deviceAllowed(): false {
  return false;
}

/** The webContents events that ask a person to pick a device; each is refused with no choice made. */
export const DEVICE_EVENTS = ["select-serial-port", "select-usb-device", "select-hid-device", "select-bluetooth-device"] as const;
